/**
 * Scoring Agent — holistic deSPAC suitability assessment for one or many companies.
 *
 * Scoring dimensions (total = 100 pts):
 *   market_timing         0–20  ← market size + growth potential signals
 *   product_defensibility 0–20  ← technology moat
 *   narrative_strength    0–20  ← deSPAC readiness / investor story
 *   founder_quality       0–20  ← management quality
 *   team_depth            0–20  ← organisation depth
 *
 * Accepts two input shapes via AgentInput.payload:
 *   Batch  : { companyIds?: string[]; sector?: string; searchCriteria?: object }
 *   Single : { companyId: string; company: object }  (BullMQ worker path)
 *
 * Status flow per company: sourced → scoring → reviewed
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed) with progress
 *   - Sets companies.despac_score and companies.status per company
 *   - Writes one agent_results row per company (result_type = "score")
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";
import type { Company } from "@/types/database";

// ---------------------------------------------------------------------------
// LLM clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10;

/** Milliseconds to wait between batches to avoid LLM rate limits. */
const INTER_BATCH_DELAY_MS = 1_500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-dimension breakdown matching the Scoring prompt OUTPUT schema exactly. */
export interface ScoringBreakdown {
  /** Management quality — founder background, track record, domain expertise. */
  founder_quality: number;       // 0–20
  /** Org depth — bench strength beyond founders, key hires. */
  team_depth: number;            // 0–20
  /** Technology moat — IP, proprietary tech, switching costs. */
  product_defensibility: number; // 0–20
  /** Market size + growth potential — TAM, CAGR, sector tailwinds. */
  market_timing: number;         // 0–20
  /** deSPAC readiness — investor narrative, story clarity, comparables. */
  narrative_strength: number;    // 0–20
}

export interface CompanyScoringResult {
  companyId: string;
  companyName: string;
  despac_score: number;
  score_breakdown: ScoringBreakdown;
  rationale: string;
  recommendation: "approve" | "review" | "reject";
  flags: string[];
  modelUsed: string;
}

export interface ScoringRunResult {
  taskId: string;
  mode: "batch" | "single";
  totalRequested: number;
  totalScored: number;
  totalFailed: number;
  results: CompanyScoringResult[];
  modelUsed: string;
}

/** Raw LLM response shape — validated before use. */
interface LlmScoringResponse {
  companyId: string;
  despac_score: number;
  qualitative_signals: ScoringBreakdown;
  rationale: string;
  recommendation: "approve" | "review" | "reject";
  flags: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_RECOMMENDATIONS = new Set(["approve", "review", "reject"]);

function validateLlmResponse(raw: unknown, fallbackCompanyId: string): LlmScoringResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Scoring response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  const score = Number(r.despac_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`Invalid despac_score: ${String(r.despac_score)}`);
  }

  const qs = (r.qualitative_signals ?? {}) as Record<string, unknown>;

  if (!VALID_RECOMMENDATIONS.has(String(r.recommendation))) {
    throw new Error(`Invalid recommendation: ${String(r.recommendation)}`);
  }

  return {
    companyId: String(r.companyId ?? fallbackCompanyId),
    despac_score: Math.round(score),
    qualitative_signals: {
      founder_quality:       Math.round(Number(qs.founder_quality       ?? 0)),
      team_depth:            Math.round(Number(qs.team_depth            ?? 0)),
      product_defensibility: Math.round(Number(qs.product_defensibility ?? 0)),
      market_timing:         Math.round(Number(qs.market_timing         ?? 0)),
      narrative_strength:    Math.round(Number(qs.narrative_strength    ?? 0)),
    },
    rationale:      String(r.rationale ?? ""),
    recommendation: r.recommendation as "approve" | "review" | "reject",
    flags:          Array.isArray(r.flags) ? (r.flags as string[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fetch companies by IDs or sector
// ---------------------------------------------------------------------------

type CompanyRow = Pick<
  Company,
  | "id"
  | "name"
  | "sector"
  | "sub_sector"
  | "blurb"
  | "estimated_valuation"
  | "last_round"
  | "despac_score"
  | "status"
>;

async function fetchCompaniesByIds(companyIds: string[]): Promise<CompanyRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id, name, sector, sub_sector, blurb, estimated_valuation, last_round, despac_score, status"
    )
    .in("id", companyIds);

  if (error) throw new Error(`Failed to fetch companies by IDs: ${error.message}`);
  return (data ?? []) as CompanyRow[];
}

async function fetchCompaniesBySector(sector: string): Promise<CompanyRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id, name, sector, sub_sector, blurb, estimated_valuation, last_round, despac_score, status"
    )
    .eq("sector", sector)
    .neq("status", "rejected")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`Failed to fetch companies by sector: ${error.message}`);
  return (data ?? []) as CompanyRow[];
}

async function fetchAllUnscoredCompanies(): Promise<CompanyRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id, name, sector, sub_sector, blurb, estimated_valuation, last_round, despac_score, status"
    )
    .is("despac_score", null)
    .neq("status", "rejected")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`Failed to fetch unscored companies: ${error.message}`);
  return (data ?? []) as CompanyRow[];
}

// ---------------------------------------------------------------------------
// Progress update (non-blocking write)
// ---------------------------------------------------------------------------

function writeProgress(
  taskId: string,
  processed: number,
  total: number,
  lastCompany: string
): void {
  const supabase = createAdminClient();
  supabase
    .from("agent_tasks")
    .update({
      output: { processed, total, lastCompany, updatedAt: nowIso() },
    })
    .eq("id", taskId)
    .then(({ error }) => {
      if (error) {
        console.warn("[Scoring agent] Progress update failed:", error.message);
      }
    });
}

// ---------------------------------------------------------------------------
// Per-company LLM scoring
// ---------------------------------------------------------------------------

/**
 * Calls Claude (with OpenAI fallback) to score a single company.
 * Sends the company profile in the format the Scoring system prompt expects.
 */
async function scoreOneCompany(
  company: CompanyRow,
  contacts: Array<Record<string, unknown>>,
  cfoScore: number | null
): Promise<{ parsed: LlmScoringResponse; modelUsed: string }> {
  const userMessage = JSON.stringify({
    companyId:           company.id,
    name:                company.name,
    sector:              company.sector,
    sub_sector:          company.sub_sector,
    blurb:               company.blurb,
    estimated_revenue:   null, // not in DB schema; included in blurb if known
    estimated_valuation: company.estimated_valuation,
    last_round:          company.last_round,
    contacts,
    cfo_score:           cfoScore,
    approvedByHuman:     false,
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 1024,
    system:     AGENT_PROMPTS.scoring,
    messages:   [{ role: "user", content: userMessage }],
  });

  if (message.content[0].type !== "text") {
    throw new Error("Claude returned a non-text content block");
  }

  const responseText = message.content[0].text;
  const modelUsed    = config.anthropic.model;

  const jsonText = responseText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  const parsed = validateLlmResponse(JSON.parse(jsonText), company.id);
  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// Per-company DB writes
// ---------------------------------------------------------------------------

async function markCompanyScoring(companyId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("companies")
    .update({ status: "scoring", updated_at: nowIso() })
    .eq("id", companyId);

  if (error) {
    console.warn(`[Scoring agent] Failed to mark company ${companyId} as scoring:`, error.message);
  }
}

async function finaliseCompany(
  companyId: string,
  score: number
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("companies")
    .update({
      despac_score: score,
      status:       "reviewed",
      updated_at:   nowIso(),
    })
    .eq("id", companyId);

  if (error) {
    throw new Error(
      `Failed to update despac_score for company ${companyId}: ${error.message}`
    );
  }
}

async function writeAgentResult(
  taskId: string,
  companyId: string,
  scoringResult: CompanyScoringResult
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "scoring",
    result_type: "score",
    content: {
      despac_score:    scoringResult.despac_score,
      score_breakdown: scoringResult.score_breakdown,
      rationale:       scoringResult.rationale,
      recommendation:  scoringResult.recommendation,
      flags:           scoringResult.flags,
      modelUsed:       scoringResult.modelUsed,
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    // Non-fatal — score already written to companies table
    console.error("[Scoring agent] Failed to write agent_results:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Fetch existing CFO scores + contacts for a batch
// ---------------------------------------------------------------------------

async function fetchCfoScores(
  companyIds: string[]
): Promise<Map<string, number | null>> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_results")
    .select("company_id, content")
    .in("company_id", companyIds)
    .eq("result_type", "score")
    .eq("agent_name", "cfo");

  const map = new Map<string, number | null>();
  for (const row of data ?? []) {
    if (row.company_id) {
      const score = (row.content as Record<string, unknown>).despac_score;
      map.set(row.company_id, typeof score === "number" ? score : null);
    }
  }
  return map;
}

async function fetchContactsForCompanies(
  companyIds: string[]
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("contacts")
    .select("company_id, name, title, email, linkedin_url, phone")
    .in("company_id", companyIds);

  const map = new Map<string, Array<Record<string, unknown>>>();
  for (const row of data ?? []) {
    if (!row.company_id) continue;
    const existing = map.get(row.company_id) ?? [];
    existing.push({
      name:         row.name,
      title:        row.title,
      email:        row.email,
      linkedin_url: row.linkedin_url,
      phone:        row.phone,
    });
    map.set(row.company_id, existing);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Batch processor
// ---------------------------------------------------------------------------

async function processCompaniesInBatches(
  taskId: string,
  companies: CompanyRow[],
  initialModelUsed: string
): Promise<{
  results: CompanyScoringResult[];
  totalScored: number;
  totalFailed: number;
  modelUsed: string;
}> {
  const results: CompanyScoringResult[] = [];
  let totalScored  = 0;
  let totalFailed  = 0;
  let modelUsed    = initialModelUsed;
  const total      = companies.length;

  for (let batchStart = 0; batchStart < companies.length; batchStart += BATCH_SIZE) {
    const batch = companies.slice(batchStart, batchStart + BATCH_SIZE);
    const batchIds = batch.map((c) => c.id);

    // Fetch CFO scores + contacts for the batch in parallel
    const [cfoScores, contactsMap] = await Promise.all([
      fetchCfoScores(batchIds),
      fetchContactsForCompanies(batchIds),
    ]);

    // Mark all companies in batch as "scoring" before LLM calls
    await Promise.all(batch.map((c) => markCompanyScoring(c.id)));

    for (const company of batch) {
      try {
        const contacts   = contactsMap.get(company.id) ?? [];
        const cfoScore   = cfoScores.get(company.id) ?? null;

        const { parsed, modelUsed: usedModel } = await scoreOneCompany(
          company,
          contacts,
          cfoScore
        );

        modelUsed = usedModel; // track last used model

        await finaliseCompany(company.id, parsed.despac_score);

        const companyResult: CompanyScoringResult = {
          companyId:       company.id,
          companyName:     company.name,
          despac_score:    parsed.despac_score,
          score_breakdown: parsed.qualitative_signals,
          rationale:       parsed.rationale,
          recommendation:  parsed.recommendation,
          flags:           parsed.flags,
          modelUsed:       usedModel,
        };

        await writeAgentResult(taskId, company.id, companyResult);

        results.push(companyResult);
        totalScored++;
      } catch (err) {
        console.error(
          `[Scoring agent] Failed to score company "${company.name}" (${company.id}):`,
          err
        );

        // Revert status back to "sourced" so it can be retried
        const supabase = createAdminClient();
        await supabase
          .from("companies")
          .update({ status: "sourced", updated_at: nowIso() })
          .eq("id", company.id);

        totalFailed++;
      }

      // Progress update after each company (non-blocking)
      writeProgress(taskId, totalScored + totalFailed, total, company.name);
    }

    // Pause between batches (skip after last batch)
    if (batchStart + BATCH_SIZE < companies.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  return { results, totalScored, totalFailed, modelUsed };
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Scoring agent.
 *
 * Dispatch modes (detected from input.payload):
 *   Batch  — payload.companyIds[] or payload.sector or neither (all unscored)
 *   Single — payload.companyId + payload.company (BullMQ worker path)
 *
 * Flow:
 *   1. Mark agent_tasks row as running.
 *   2. Resolve the list of companies to score.
 *   3. Process companies in batches of 10:
 *      a. Mark company status "scoring".
 *      b. Fetch CFO score + enriched contacts for the batch.
 *      c. Call Claude; fall back to OpenAI on failure.
 *      d. Validate LLM response.
 *      e. Set companies.despac_score + status "reviewed".
 *      f. Write agent_results row (result_type = "score").
 *      g. Write progress to agent_tasks.output.
 *   4. Mark agent_tasks completed (or failed on total failure).
 *   5. Return ScoringRunResult.
 *
 * @param input - AgentInput from BullMQ worker or API route
 * @returns     ScoringRunResult with per-company score results
 * @throws      If no companies can be resolved or all companies fail
 */
export async function runScoringAgent(input: AgentInput): Promise<ScoringRunResult> {
  const supabase = createAdminClient();
  const payload  = input.payload ?? {};

  // ------------------------------------------------------------------
  // 1. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: nowIso() })
    .eq("id", input.taskId);

  try {
    // ------------------------------------------------------------------
    // 2. Resolve companies list
    // ------------------------------------------------------------------
    let companies: CompanyRow[];
    let mode: "batch" | "single";

    const payloadCompanyIds = payload.companyIds;
    const payloadSector     = payload.sector;
    const payloadCompany    = payload.company;
    const payloadCompanyId  = payload.companyId ?? input.companyId;

    if (
      payloadCompanyId &&
      payloadCompany &&
      typeof payloadCompany === "object" &&
      !Array.isArray(payloadCompanyIds)
    ) {
      // Single-company path (BullMQ worker dispatch)
      mode      = "single";
      companies = [
        {
          id:                  String(payloadCompanyId),
          name:                String((payloadCompany as Record<string, unknown>).name ?? "Unknown"),
          sector:              String((payloadCompany as Record<string, unknown>).sector ?? "") || null,
          sub_sector:          String((payloadCompany as Record<string, unknown>).sub_sector ?? "") || null,
          blurb:               String((payloadCompany as Record<string, unknown>).blurb ?? "") || null,
          estimated_valuation: String((payloadCompany as Record<string, unknown>).estimated_valuation ?? "") || null,
          last_round:          String((payloadCompany as Record<string, unknown>).last_round ?? "") || null,
          despac_score:        null,
          status:              "sourced",
        } as CompanyRow,
      ];
    } else if (Array.isArray(payloadCompanyIds) && payloadCompanyIds.length > 0) {
      // Batch by explicit ID list
      mode      = "batch";
      companies = await fetchCompaniesByIds(payloadCompanyIds as string[]);
    } else if (typeof payloadSector === "string" && payloadSector) {
      // Batch by sector filter
      mode      = "batch";
      companies = await fetchCompaniesBySector(payloadSector);
    } else {
      // Default: score all unscored companies
      mode      = "batch";
      companies = await fetchAllUnscoredCompanies();
    }

    if (companies.length === 0) {
      const emptyResult: ScoringRunResult = {
        taskId:         input.taskId,
        mode,
        totalRequested: 0,
        totalScored:    0,
        totalFailed:    0,
        results:        [],
        modelUsed:      "none",
      };

      await supabase
        .from("agent_tasks")
        .update({
          status:       "completed",
          output:       emptyResult as unknown as Record<string, unknown>,
          completed_at: nowIso(),
        })
        .eq("id", input.taskId);

      return emptyResult;
    }

    // ------------------------------------------------------------------
    // 3. Process in batches
    // ------------------------------------------------------------------
    const { results, totalScored, totalFailed, modelUsed } =
      await processCompaniesInBatches(input.taskId, companies, config.anthropic.model);

    // ------------------------------------------------------------------
    // 4. Mark task completed
    // ------------------------------------------------------------------
    const finalResult: ScoringRunResult = {
      taskId:         input.taskId,
      mode,
      totalRequested: companies.length,
      totalScored,
      totalFailed,
      results,
      modelUsed,
    };

    await supabase
      .from("agent_tasks")
      .update({
        status:       "completed",
        output:       finalResult as unknown as Record<string, unknown>,
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    return finalResult;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    await supabase
      .from("agent_tasks")
      .update({ status: "failed", error, completed_at: nowIso() })
      .eq("id", input.taskId);

    throw err;
  }
}
