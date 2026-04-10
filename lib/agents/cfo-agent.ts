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
// LLM clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-dimension score breakdown.
 * Matches the CFO system prompt's output schema exactly.
 *   revenue_fit      0–30 pts
 *   valuation_band   0–25 pts
 *   sector_alignment 0–25 pts
 *   redemption_risk  0–20 pts
 */
export interface CfoScoreBreakdown {
  revenue_fit: number;
  valuation_band: number;
  sector_alignment: number;
  redemption_risk: number;
}

/**
 * Per-dimension rationale strings returned by the LLM.
 * Mirror keys of CfoScoreBreakdown.
 */
export interface CfoRationale {
  revenue_fit: string;
  valuation_band: string;
  sector_alignment: string;
  redemption_risk: string;
}

/** The structured result returned by runCfoAgent — and written to agent_results. */
export interface CfoRunResult {
  /** UUID of the agent_tasks row created for this run. */
  taskId: string;
  /** UUID of the scored company. */
  companyId: string;
  /** Aggregate score 0–100 (sum of breakdown dimensions). */
  despac_score: number;
  /** Individual dimension scores. */
  score_breakdown: CfoScoreBreakdown;
  /** Plain-English rationale per dimension. */
  rationale: CfoRationale;
  /** Deal recommendation from the LLM. */
  recommendation: "approve" | "review" | "reject";
  /** LLM confidence in the output given the available data. */
  confidence: "low" | "medium" | "high";
  /** Which model produced this result. */
  modelUsed: string;
}

/** Raw shape expected from the LLM — validated before use. */
interface LlmCfoResponse {
  companyId: string;
  despac_score: number;
  score_breakdown: CfoScoreBreakdown;
  rationale: CfoRationale;
  recommendation: "approve" | "review" | "reject";
  confidence: "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_RECOMMENDATIONS = new Set(["approve", "review", "reject"]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

/**
 * Validates and normalises the raw LLM JSON response.
 * Throws a descriptive error if required fields are missing or out of range.
 */
function validateLlmResponse(raw: unknown): LlmCfoResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("CFO agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  const score = Number(r.despac_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(
      `CFO agent returned invalid despac_score: ${String(r.despac_score)}`
    );
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
    throw new Error(
      `CFO agent returned invalid recommendation: ${String(r.recommendation)}`
    );
  }

  const confidence = VALID_CONFIDENCE.has(String(r.confidence))
    ? (r.confidence as "low" | "medium" | "high")
    : "low";

  return {
    companyId: String(r.companyId ?? ""),
    despac_score: Math.round(score),
    score_breakdown: {
      revenue_fit: Number(breakdown.revenue_fit ?? 0),
      valuation_band: Number(breakdown.valuation_band ?? 0),
      sector_alignment: Number(breakdown.sector_alignment ?? 0),
      redemption_risk: Number(breakdown.redemption_risk ?? 0),
    },
    rationale: {
      revenue_fit: String(rationale.revenue_fit ?? ""),
      valuation_band: String(rationale.valuation_band ?? ""),
      sector_alignment: String(rationale.sector_alignment ?? ""),
      redemption_risk: String(rationale.redemption_risk ?? ""),
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
 * Accepts AgentInput so it is compatible with the BullMQ worker dispatch
 * pattern. Company fields are expected in input.payload; the API route
 * builds the correct payload shape before calling this function.
 *
 * Flow:
 *   1. Mark agent_tasks row as running.
 *   2. Call Claude (claude-sonnet-4-20250514); fall back to OpenAI gpt-4o on failure.
 *   3. Parse and validate the structured JSON response.
 *   4. Update companies.despac_score in Supabase.
 *   5. Write a scored row to agent_results.
 *   6. Mark agent_tasks row as completed (or failed on any error).
 *   7. Return the structured CfoRunResult.
 *
 * @param input - AgentInput with company fields in payload and companyId set
 * @returns     CfoRunResult with score, breakdown, recommendation, and reasoning
 * @throws      On LLM or database errors after marking the task failed
 */
export async function runCfoAgent(input: AgentInput): Promise<CfoRunResult> {
  const supabase = createAdminClient();
  const payload = input.payload ?? {};
  const companyId = input.companyId ?? String(payload.companyId ?? "");

  if (!companyId) {
    throw new Error("CFO agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", input.taskId);

  try {
    // ------------------------------------------------------------------
    // 2. Call Claude
    // ------------------------------------------------------------------
    const userMessage = JSON.stringify({
      companyId,
      name: payload.name ?? null,
      sector: payload.sector ?? null,
      sub_sector: payload.sub_sector ?? null,
      estimated_revenue: payload.estimated_revenue ?? null,
      estimated_valuation: payload.estimated_valuation ?? null,
      last_round: payload.last_round ?? null,
      blurb: payload.blurb ?? null,
      approvedByHuman: input.approvedByHuman ?? false,
    });

    const message = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: AGENT_PROMPTS.cfo,
      messages: [{ role: "user", content: userMessage }],
    });

    if (message.content[0].type !== "text") {
      throw new Error("Claude returned a non-text content block");
    }

    const responseText = message.content[0].text;
    const modelUsed = config.anthropic.model;

    // ------------------------------------------------------------------
    // 3. Parse and validate
    // ------------------------------------------------------------------
    let parsed: LlmCfoResponse;
    try {
      parsed = validateLlmResponse(JSON.parse(responseText));
    } catch {
      throw new Error(
        `CFO agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
      );
    }

    // ------------------------------------------------------------------
    // 4. Update companies.despac_score
    // ------------------------------------------------------------------
    const { error: scoreUpdateError } = await supabase
      .from("companies")
      .update({
        despac_score: parsed.despac_score,
        status: "scoring",
        updated_at: new Date().toISOString(),
      })
      .eq("id", companyId);

    if (scoreUpdateError) {
      throw new Error(
        `Failed to update despac_score for company ${companyId}: ${scoreUpdateError.message}`
      );
    }

    // ------------------------------------------------------------------
    // 5. Write to agent_results
    // ------------------------------------------------------------------
    const resultContent: Record<string, unknown> = {
      despac_score: parsed.despac_score,
      score_breakdown: parsed.score_breakdown,
      rationale: parsed.rationale,
      recommendation: parsed.recommendation,
      confidence: parsed.confidence,
      modelUsed,
    };

    const { error: resultError } = await supabase.from("agent_results").insert({
      task_id: input.taskId,
      company_id: companyId,
      agent_name: "cfo",
      result_type: "score",
      content: resultContent,
    });

    if (resultError) {
      // Non-fatal: log but don't fail the task — score is already written
      console.error(
        "[CFO agent] Failed to insert agent_results row:",
        resultError.message
      );
    }

    // ------------------------------------------------------------------
    // 6. Mark task completed
    // ------------------------------------------------------------------
    await supabase
      .from("agent_tasks")
      .update({
        status: "completed",
        output: resultContent,
        completed_at: new Date().toISOString(),
      })
      .eq("id", input.taskId);

    // ------------------------------------------------------------------
    // 7. Return structured result
    // ------------------------------------------------------------------
    return {
      taskId: input.taskId,
      companyId,
      despac_score: parsed.despac_score,
      score_breakdown: parsed.score_breakdown,
      rationale: parsed.rationale,
      recommendation: parsed.recommendation,
      confidence: parsed.confidence,
      modelUsed,
    };
  } catch (err) {
    // Never leave a task stuck at "running"
    const error = err instanceof Error ? err.message : String(err);

    await supabase
      .from("agent_tasks")
      .update({
        status: "failed",
        error,
        completed_at: new Date().toISOString(),
      })
      .eq("id", input.taskId);

    throw err;
  }
}
