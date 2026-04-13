/**
 * CFO Agent — financial due diligence and deSPAC scoring.
 *
 * Input:  AgentInput (company fields arrive via input.payload, taskId via input.taskId)
 * Output: CfoRunResult containing despac_score, score_breakdown, recommendation, reasoning
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Updates companies.despac_score in Supabase
 *   - Writes a scored result row to agent_results (result_type = "score")
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "./prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

// ---------------------------------------------------------------------------
// LLM client
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CfoScoreBreakdown {
  revenue_fit: number;
  valuation_band: number;
  sector_alignment: number;
  redemption_risk: number;
}

export interface CfoRationale {
  revenue_fit: string;
  valuation_band: string;
  sector_alignment: string;
  redemption_risk: string;
}

export interface CfoRunResult {
  taskId: string;
  companyId: string;
  despac_score: number;
  score_breakdown: CfoScoreBreakdown;
  rationale: CfoRationale;
  recommendation: "approve" | "review" | "reject";
  confidence: "low" | "medium" | "high";
  modelUsed: string;
}

interface LlmCfoResponse {
  companyId: string;
  despac_score: number;
  score_breakdown: CfoScoreBreakdown;
  rationale: CfoRationale;
  recommendation: "approve" | "review" | "reject";
  confidence: "low" | "medium" | "high";
}

/** A single filing extracted from the EDGAR full-text search response. */
interface EdgarFiling {
  entityName: string;
  formType: string;
  fileDate: string;
  periodOfReport: string | null;
  description: string;
}

// ---------------------------------------------------------------------------
// EDGAR fetch
// ---------------------------------------------------------------------------

/**
 * Searches the SEC EDGAR full-text search API for 10-K and S-1 filings
 * matching the company name. Returns up to 5 filings with key metadata.
 *
 * Uses a 5-second AbortController timeout — EDGAR can be slow. On any
 * error or timeout the function returns null so scoring continues without
 * EDGAR data rather than failing the entire task.
 *
 * @param companyName - The company name to search for in EDGAR
 * @returns Array of matched filings, or null if the fetch failed / timed out
 */
async function fetchEdgarFilings(companyName: string): Promise<EdgarFiling[] | null> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  try {
    const encoded = encodeURIComponent(`"${companyName}"`);
    const url = [
      "https://efts.sec.gov/LATEST/search-index",
      `?q=${encoded}`,
      "&forms=10-K,S-1",
      "&dateRange=custom",
      "&startdt=2020-01-01",
      "&enddt=2025-01-01",
      "&hits.hits.total.relation=eq",
      "&hits.hits._source=entity_name,file_date,period_of_report,form_type,description",
    ].join("");

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { "User-Agent": "BHAV-Acquisition-Corp contact@bhav.io" },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      hits?: {
        hits?: {
          _source?: {
            entity_name?: string;
            form_type?: string;
            file_date?: string;
            period_of_report?: string;
            description?: string;
          };
        }[];
      };
    };

    const hits = json?.hits?.hits ?? [];
    if (hits.length === 0) return null;

    return hits.slice(0, 5).map((hit) => ({
      entityName:     String(hit._source?.entity_name    ?? ""),
      formType:       String(hit._source?.form_type       ?? ""),
      fileDate:       String(hit._source?.file_date        ?? ""),
      periodOfReport: hit._source?.period_of_report != null
        ? String(hit._source.period_of_report)
        : null,
      description:    String(hit._source?.description     ?? ""),
    }));
  } catch {
    // Timeout (AbortError) or network error — fall back silently
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// LLM response validation
// ---------------------------------------------------------------------------

const VALID_RECOMMENDATIONS = new Set(["approve", "review", "reject"]);
const VALID_CONFIDENCE       = new Set(["low", "medium", "high"]);

function validateLlmResponse(raw: unknown): LlmCfoResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("CFO agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  const score = Number(r.despac_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`CFO agent returned invalid despac_score: ${String(r.despac_score)}`);
  }

  const breakdown = r.score_breakdown as Record<string, unknown> | undefined;
  if (!breakdown || typeof breakdown !== "object") {
    throw new Error("CFO agent response missing score_breakdown");
  }

  const rationale = r.rationale as Record<string, unknown> | undefined;
  if (!rationale || typeof rationale !== "object") {
    throw new Error("CFO agent response missing rationale");
  }

  if (!VALID_RECOMMENDATIONS.has(String(r.recommendation))) {
    throw new Error(`CFO agent returned invalid recommendation: ${String(r.recommendation)}`);
  }

  const confidence = VALID_CONFIDENCE.has(String(r.confidence))
    ? (r.confidence as "low" | "medium" | "high")
    : "low";

  return {
    companyId:    String(r.companyId ?? ""),
    despac_score: Math.round(score),
    score_breakdown: {
      revenue_fit:      Number(breakdown.revenue_fit      ?? 0),
      valuation_band:   Number(breakdown.valuation_band   ?? 0),
      sector_alignment: Number(breakdown.sector_alignment ?? 0),
      redemption_risk:  Number(breakdown.redemption_risk  ?? 0),
    },
    rationale: {
      revenue_fit:      String(rationale.revenue_fit      ?? ""),
      valuation_band:   String(rationale.valuation_band   ?? ""),
      sector_alignment: String(rationale.sector_alignment ?? ""),
      redemption_risk:  String(rationale.redemption_risk  ?? ""),
    },
    recommendation: r.recommendation as "approve" | "review" | "reject",
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the CFO agent against a company record.
 *
 * Flow:
 *   1. Mark agent_tasks row as running.
 *   2. Fetch EDGAR 10-K/S-1 filings for the company (5 s timeout, non-fatal).
 *   3. Fetch any prior sourcing agent_results from Supabase.
 *   4. Build enriched prompt: company fields + EDGAR data + sourcing intel.
 *   5. Call Claude and parse the structured JSON response.
 *   6. Update companies.despac_score in Supabase.
 *   7. Write a scored row to agent_results.
 *   8. Mark agent_tasks row as completed (or failed on any error).
 *   9. Return the structured CfoRunResult.
 */
export async function runCfoAgent(input: AgentInput): Promise<CfoRunResult> {
  const supabase  = createAdminClient();
  const payload   = input.payload ?? {};
  const companyId = input.companyId ?? String(payload.companyId ?? "");

  // ------------------------------------------------------------------
  // Startup diagnostics — printed to Railway logs on every run
  // ------------------------------------------------------------------
  console.log("[CFO agent] ── START ──────────────────────────────────────");
  console.log("[CFO agent] taskId         :", input.taskId);
  console.log("[CFO agent] input.companyId:", input.companyId ?? "(not set)");
  console.log("[CFO agent] payload.companyId:", String(payload.companyId ?? "(not set)"));
  console.log("[CFO agent] resolved companyId:", companyId || "(EMPTY — will throw)");
  console.log("[CFO agent] supabase URL   :", process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(NOT SET — DB calls will fail)");
  console.log("[CFO agent] service key set:", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY));

  if (!companyId) throw new Error("CFO agent requires a companyId");

  // ------------------------------------------------------------------
  // 1. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", input.taskId);

  try {
    const companyName = String(payload.name ?? "");

    // ------------------------------------------------------------------
    // 2. Fetch EDGAR filings (5 s timeout — non-fatal on failure)
    // ------------------------------------------------------------------
    const edgarFilings = companyName
      ? await fetchEdgarFilings(companyName)
      : null;

    if (edgarFilings) {
      console.log(
        `[CFO agent] EDGAR: found ${edgarFilings.length} filing(s) for "${companyName}"`
      );
    } else {
      console.log(
        `[CFO agent] EDGAR: no filings found for "${companyName}" — using Excel fields only`
      );
    }

    // ------------------------------------------------------------------
    // 3. Fetch prior sourcing intel from Supabase (non-fatal if absent)
    // ------------------------------------------------------------------
    const { data: sourcingRows } = await supabase
      .from("agent_results")
      .select("content")
      .eq("company_id", companyId)
      .eq("result_type", "sourcing")
      .order("created_at", { ascending: false })
      .limit(3);

    const sourcingIntel: unknown[] = (sourcingRows ?? []).map((r) => r.content);

    // ------------------------------------------------------------------
    // 4. Build enriched user message
    // ------------------------------------------------------------------
    const userMessage = JSON.stringify({
      companyId,
      name:                payload.name                ?? null,
      sector:              payload.sector              ?? null,
      sub_sector:          payload.sub_sector          ?? null,
      estimated_revenue:   payload.estimated_revenue   ?? null,
      estimated_valuation: payload.estimated_valuation ?? null,
      last_round:          payload.last_round          ?? null,
      blurb:               payload.blurb               ?? null,
      approvedByHuman:     input.approvedByHuman       ?? false,
      // EDGAR SEC filings — 10-K and S-1 data found for this company
      edgar_filings:  edgarFilings  ?? null,
      // Prior sourcing agent context (news, revenue signals, etc.)
      sourcing_intel: sourcingIntel.length > 0 ? sourcingIntel : null,
    });

    // ------------------------------------------------------------------
    // 5. Call Claude
    // ------------------------------------------------------------------
    const message = await anthropic.messages.create({
      model:      config.anthropic.model,
      max_tokens: 1024,
      system:     AGENT_PROMPTS.cfo,
      messages:   [{ role: "user", content: userMessage }],
    });

    if (message.content[0].type !== "text") {
      throw new Error("Claude returned a non-text content block");
    }

    const responseText = message.content[0].text;
    const modelUsed    = config.anthropic.model;

    // Log raw response so we can see exactly what Claude returned
    console.log("[CFO agent] raw Claude response (first 600 chars):");
    console.log(responseText.slice(0, 600));

    // Strip markdown code fences — Claude sometimes wraps JSON in ```json ... ```
    const jsonText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    console.log("[CFO agent] cleaned JSON (first 400 chars):");
    console.log(jsonText.slice(0, 400));

    let parsed: LlmCfoResponse;
    try {
      parsed = validateLlmResponse(JSON.parse(jsonText));
    } catch (parseErr) {
      console.error("[CFO agent] JSON parse/validate failed:", parseErr);
      throw new Error(
        `CFO agent received invalid JSON from ${modelUsed}: ${jsonText.slice(0, 400)}`
      );
    }

    console.log("[CFO agent] parsed score   :", parsed.despac_score);
    console.log("[CFO agent] recommendation :", parsed.recommendation);
    console.log("[CFO agent] confidence     :", parsed.confidence);

    // ------------------------------------------------------------------
    // 6. Update companies.despac_score
    // NOTE: Supabase .update().eq() never errors when zero rows match —
    // it silently succeeds. We add .select("id") to detect that case.
    // ------------------------------------------------------------------
    console.log(`[CFO agent] updating companies SET despac_score=${parsed.despac_score} WHERE id=${companyId}`);

    const { data: updatedRows, error: scoreUpdateError } = await supabase
      .from("companies")
      .update({
        despac_score: parsed.despac_score,
        status:       "reviewed",
        updated_at:   new Date().toISOString(),
      })
      .eq("id", companyId)
      .select("id");

    console.log("[CFO agent] Supabase update result — error  :", scoreUpdateError ?? "none");
    console.log("[CFO agent] Supabase update result — rows   :", JSON.stringify(updatedRows));

    if (scoreUpdateError) {
      throw new Error(
        `[CFO agent] Supabase error updating companies for ${companyId}: ${scoreUpdateError.message}`
      );
    }

    if (!updatedRows || updatedRows.length === 0) {
      throw new Error(
        `[CFO agent] companies UPDATE matched 0 rows — companyId "${companyId}" not found. ` +
        `Supabase URL in use: ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(NOT SET)"}. ` +
        `Verify this companyId exists in the companies table.`
      );
    }

    console.log(
      `[CFO agent] ✓ companies.despac_score = ${parsed.despac_score}, status = "reviewed" for ${companyId}`
    );

    // ------------------------------------------------------------------
    // 7. Write to agent_results
    // ------------------------------------------------------------------
    const resultContent: Record<string, unknown> = {
      despac_score:    parsed.despac_score,
      score_breakdown: parsed.score_breakdown,
      rationale:       parsed.rationale,
      recommendation:  parsed.recommendation,
      confidence:      parsed.confidence,
      edgar_filings_used: edgarFilings ? edgarFilings.length : 0,
      modelUsed,
    };

    const { error: resultError } = await supabase.from("agent_results").insert({
      task_id:     input.taskId,
      company_id:  companyId,
      agent_name:  "cfo",
      result_type: "score",
      content:     resultContent,
    });

    if (resultError) {
      console.error("[CFO agent] Failed to insert agent_results row:", resultError.message);
    }

    // ------------------------------------------------------------------
    // 8. Mark task completed
    // ------------------------------------------------------------------
    await supabase
      .from("agent_tasks")
      .update({
        status:       "completed",
        output:       resultContent,
        completed_at: new Date().toISOString(),
      })
      .eq("id", input.taskId);

    // ------------------------------------------------------------------
    // 9. Return structured result
    // ------------------------------------------------------------------
    return {
      taskId:          input.taskId,
      companyId,
      despac_score:    parsed.despac_score,
      score_breakdown: parsed.score_breakdown,
      rationale:       parsed.rationale,
      recommendation:  parsed.recommendation,
      confidence:      parsed.confidence,
      modelUsed,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await supabase
      .from("agent_tasks")
      .update({ status: "failed", error, completed_at: new Date().toISOString() })
      .eq("id", input.taskId);
    throw err;
  }
}
