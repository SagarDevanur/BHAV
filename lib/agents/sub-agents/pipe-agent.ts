/**
 * PIPE Agent — identifies PIPE investor types and produces a deal teaser for a target.
 *
 * OUTPUT (in one LLM call):
 *   1. targetInvestors   — 10 most likely PIPE investor types ranked by match probability
 *   2. pipeRecommendation — optimal PIPE size and suggested terms
 *   3. investorTeaser    — 1-page markdown deal opportunity summary for PIPE investors
 *   4. outreachStrategy  — sequencing and positioning guidance for PIPE roadshow
 *
 * HUMAN APPROVAL GATE:
 *   - approvedByHuman: false → task marked failed; nothing is produced
 *   - approvedByHuman: true  → analysis and teaser are produced and saved;
 *                              no investor is ever contacted by this agent
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Writes agent_results row with result_type = "pipe"
 *
 * Input:  AgentInput — companyId at top level, optional deal params in payload
 * Output: PipeRunResult
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

// ---------------------------------------------------------------------------
// LLM clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BHAV_SPAC_NAME       = "BHAV Acquisition Corp";
const DEFAULT_SPAC_TRUST   = "$150M";
const TARGET_INVESTOR_COUNT = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One ranked PIPE investor type with match rationale. */
export interface PipeInvestorTarget {
  /** Rank 1 = highest match probability. */
  rank: number;
  investorName: string;
  investorType: string;
  /** Match probability as a percentage, e.g. 85. */
  matchProbability: number;
  rationale: string;
  estimatedTicketSize: string | null;
  priority: "low" | "medium" | "high";
}

/** Recommended PIPE sizing and term structure. */
export interface PipeRecommendation {
  recommendedPipeSize: string;
  minimumViablePipe: string;
  targetCloseDate: string | null;
  suggestedTerms: {
    discountToNavOrMarket: string;
    warrantCoverage: string;
    lockupPeriod: string;
    registrationRights: string;
    additionalTerms: string[];
  };
  rationale: string;
}

export interface PipeRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  /** 10 ranked investor types with match probabilities. */
  targetInvestors: PipeInvestorTarget[];
  /** Recommended PIPE size and terms. */
  pipeRecommendation: PipeRecommendation;
  /** 1-page markdown teaser for PIPE investors. */
  investorTeaser: string;
  /** Outreach sequencing and roadshow positioning guidance. */
  outreachStrategy: string;
  /** One-paragraph roadmap summary for the agent monitor. */
  pipeRoadmapSummary: string;
  /** Always true — investor list must be approved before any contact. */
  reviewRequired: true;
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Raw LLM response — validated before use. */
interface LlmPipeResponse {
  companyId: string;
  targetInvestors: PipeInvestorTarget[];
  pipeRecommendation: PipeRecommendation;
  investorTeaser: string;
  outreachStrategy: string;
  pipeRoadmapSummary: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateLlmResponse(raw: unknown, fallbackId: string): LlmPipeResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("PIPE agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  // targetInvestors must be a non-empty array
  if (!Array.isArray(r.targetInvestors) || r.targetInvestors.length === 0) {
    throw new Error("PIPE agent returned no targetInvestors");
  }

  const investorTeaser = String(r.investorTeaser ?? "").trim();
  if (!investorTeaser) {
    throw new Error("PIPE agent returned an empty investorTeaser");
  }

  // Normalise each investor entry — fill any missing fields with safe defaults
  const targetInvestors: PipeInvestorTarget[] = (
    r.targetInvestors as Record<string, unknown>[]
  ).map((inv, idx) => ({
    rank:                Number(inv.rank ?? idx + 1),
    investorName:        String(inv.investorName  ?? inv.investor_name   ?? `Investor ${idx + 1}`),
    investorType:        String(inv.investorType  ?? inv.investor_type   ?? "Institutional"),
    matchProbability:    Number(inv.matchProbability ?? inv.match_probability ?? 0),
    rationale:           String(inv.rationale ?? ""),
    estimatedTicketSize: inv.estimatedTicketSize != null ? String(inv.estimatedTicketSize) : null,
    priority:            (["low", "medium", "high"].includes(String(inv.priority))
      ? inv.priority
      : "medium") as PipeInvestorTarget["priority"],
  }));

  // pipeRecommendation — use placeholder object if missing
  const rawRec = (typeof r.pipeRecommendation === "object" && r.pipeRecommendation !== null)
    ? (r.pipeRecommendation as Record<string, unknown>)
    : {};

  const rawTerms = (typeof rawRec.suggestedTerms === "object" && rawRec.suggestedTerms !== null)
    ? (rawRec.suggestedTerms as Record<string, unknown>)
    : {};

  const pipeRecommendation: PipeRecommendation = {
    recommendedPipeSize: String(rawRec.recommendedPipeSize ?? "[PLACEHOLDER]"),
    minimumViablePipe:   String(rawRec.minimumViablePipe   ?? "[PLACEHOLDER]"),
    targetCloseDate:     rawRec.targetCloseDate != null ? String(rawRec.targetCloseDate) : null,
    suggestedTerms: {
      discountToNavOrMarket: String(rawTerms.discountToNavOrMarket ?? "[PLACEHOLDER]"),
      warrantCoverage:       String(rawTerms.warrantCoverage       ?? "[PLACEHOLDER]"),
      lockupPeriod:          String(rawTerms.lockupPeriod          ?? "[PLACEHOLDER]"),
      registrationRights:    String(rawTerms.registrationRights    ?? "[PLACEHOLDER]"),
      additionalTerms:       Array.isArray(rawTerms.additionalTerms)
        ? (rawTerms.additionalTerms as string[])
        : [],
    },
    rationale: String(rawRec.rationale ?? ""),
  };

  return {
    companyId:          String(r.companyId ?? fallbackId),
    targetInvestors,
    pipeRecommendation,
    investorTeaser,
    outreachStrategy:   String(r.outreachStrategy   ?? ""),
    pipeRoadmapSummary: String(r.pipeRoadmapSummary ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface CompanyRow {
  id: string;
  name: string;
  sector: string | null;
  sub_sector: string | null;
  blurb: string | null;
  last_round: string | null;
  estimated_valuation: string | null;
  despac_score: number | null;
  status: string;
}

interface CfoScoreContent {
  despac_score?: number;
  score_breakdown?: {
    revenue_fit?: number;
    valuation_band?: number;
    sector_alignment?: number;
    redemption_risk?: number;
  };
  rationale?: Record<string, string>;
  recommendation?: string;
  confidence?: string;
}

async function fetchCompany(companyId: string): Promise<CompanyRow> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id, name, sector, sub_sector, blurb, last_round, estimated_valuation, despac_score, status"
    )
    .eq("id", companyId)
    .single();

  if (error || !data) {
    throw new Error(`Company ${companyId} not found: ${error?.message ?? "no row"}`);
  }

  return data as CompanyRow;
}

/**
 * Fetches the most recent CFO score breakdown from agent_results.
 * Returns null if no CFO result exists for this company.
 */
async function fetchCfoScore(companyId: string): Promise<CfoScoreContent | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_results")
    .select("content")
    .eq("company_id", companyId)
    .eq("agent_name", "cfo")
    .order("created_at", { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return null;

  const row = data[0] as { content: unknown };
  if (typeof row.content !== "object" || row.content === null) return null;

  return row.content as CfoScoreContent;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(
  company: CompanyRow,
  cfoScore: CfoScoreContent | null,
  pipeSize: string | null,
  proFormaValuation: string | null,
  spacTrustSize: string,
  approvedByHuman: boolean
): Promise<{ parsed: LlmPipeResponse; modelUsed: string }> {
  const dealParameters = {
    pipeSize:           pipeSize           ?? "[PLACEHOLDER — to be sized]",
    proFormaValuation:  proFormaValuation  ?? company.estimated_valuation ?? "[PLACEHOLDER]",
    spac_name:          BHAV_SPAC_NAME,
    spac_trust_size:    spacTrustSize,
    dealStructure:      "deSPAC merger",
  };

  const userMessage = JSON.stringify({
    companyId:           company.id,
    companyName:         company.name,
    sector:              company.sector,
    sub_sector:          company.sub_sector,
    blurb:               company.blurb,
    estimated_valuation: company.estimated_valuation,
    last_round:          company.last_round,
    despac_score:        company.despac_score ?? cfoScore?.despac_score ?? null,
    cfo_score_breakdown: cfoScore?.score_breakdown ?? null,
    cfo_recommendation:  cfoScore?.recommendation  ?? null,
    dealParameters,
    approvedByHuman,
    targetInvestorCount: TARGET_INVESTOR_COUNT,
    instructions:
      "Produce a complete PIPE analysis in a single JSON response with these exact keys: " +
      `companyId, ` +
      `targetInvestors (array of exactly ${TARGET_INVESTOR_COUNT} objects, each with: ` +
      "rank, investorName, investorType, matchProbability (integer 0–100), rationale, " +
      "estimatedTicketSize (string or null), priority ('low'|'medium'|'high')), " +
      "pipeRecommendation (object: recommendedPipeSize, minimumViablePipe, targetCloseDate, " +
      "suggestedTerms{discountToNavOrMarket, warrantCoverage, lockupPeriod, registrationRights, additionalTerms[]}, rationale), " +
      "investorTeaser (1-page markdown summary of the deal opportunity for PIPE investors — include company overview, " +
      "sector thesis, transaction summary, use of proceeds, and key investment highlights), " +
      "outreachStrategy (markdown: sequencing, positioning, and roadshow guidance), " +
      "pipeRoadmapSummary (one-paragraph plain-text summary). " +
      "Rank investors by matchProbability descending. Use [PLACEHOLDER] for missing figures. " +
      "Set reviewRequired to true in all materials.",
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 6144,
    system:     AGENT_PROMPTS.pipe,
    messages:   [{ role: "user", content: userMessage }],
  });

  if (message.content[0].type !== "text") {
    throw new Error("Claude returned a non-text content block");
  }

  const responseText = message.content[0].text;
  const modelUsed    = config.anthropic.model;

  // Strip markdown code fences — Claude sometimes wraps JSON in ```json ... ```
  // even when instructed not to. The /g flag handles fences anywhere in the string.
  const jsonText = responseText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  let parsed: LlmPipeResponse;
  try {
    parsed = validateLlmResponse(JSON.parse(jsonText), company.id);
  } catch {
    throw new Error(
      `PIPE agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

async function savePipeResult(
  taskId: string,
  companyId: string,
  parsed: LlmPipeResponse,
  approvedByHuman: boolean,
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "pipe",
    result_type: "pipe",
    content: {
      targetInvestors:    parsed.targetInvestors,
      pipeRecommendation: parsed.pipeRecommendation,
      investorTeaser:     parsed.investorTeaser,
      outreachStrategy:   parsed.outreachStrategy,
      pipeRoadmapSummary: parsed.pipeRoadmapSummary,
      reviewRequired:     true,
      approvedByHuman,
      modelUsed,
      analyzedAt:         nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    throw new Error(`Failed to save PIPE result to agent_results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the PIPE agent to produce a full investor targeting analysis and deal teaser.
 *
 * Flow:
 *   1. Enforce the human approval gate — mark failed and throw if not approved.
 *   2. Mark agent_tasks row as running.
 *   3. Fetch company record and CFO score breakdown in parallel.
 *   4. Call Claude requesting all four outputs in one response; fall back to OpenAI.
 *   5. Validate LLM response — targetInvestors must be non-empty; investorTeaser must be present.
 *   6. Save full analysis to agent_results (result_type = "pipe").
 *   7. Mark agent_tasks completed (or failed on any error).
 *   8. Return PipeRunResult for dashboard display.
 *
 * @param input - AgentInput; companyId at top level, optional deal params in payload
 * @returns     PipeRunResult with ranked investors, recommendation, teaser, and strategy
 * @throws      If approvedByHuman is false/absent, or on LLM / DB errors
 */
export async function runPipeAgent(input: AgentInput): Promise<PipeRunResult> {
  const supabase        = createAdminClient();
  const companyId       = input.companyId ?? String((input.payload ?? {}).companyId ?? "");
  const approvedByHuman = input.approvedByHuman === true;

  if (!companyId) {
    throw new Error("PIPE agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Human approval gate
  // ------------------------------------------------------------------
  if (!approvedByHuman) {
    await supabase
      .from("agent_tasks")
      .update({
        status:       "failed",
        error:        "PIPE agent requires approvedByHuman: true. Set this flag to authorise investor targeting.",
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    throw new Error(
      "PIPE agent requires approvedByHuman: true. " +
        "Ensure a co-founder has explicitly approved before dispatching the PIPE agent."
    );
  }

  // ------------------------------------------------------------------
  // 2. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: nowIso() })
    .eq("id", input.taskId);

  try {
    // ------------------------------------------------------------------
    // 3. Fetch company and CFO score in parallel
    // ------------------------------------------------------------------
    const [company, cfoScore] = await Promise.all([
      fetchCompany(companyId),
      fetchCfoScore(companyId),
    ]);

    // Optional caller overrides
    const payload          = input.payload ?? {};
    const pipeSize         = typeof payload.pipeSize         === "string" ? payload.pipeSize         : null;
    const proFormaVal      = typeof payload.proFormaValuation === "string" ? payload.proFormaValuation : null;
    const spacTrustSize    = typeof payload.spac_trust_size   === "string" ? payload.spac_trust_size   : DEFAULT_SPAC_TRUST;

    // ------------------------------------------------------------------
    // 4 + 5. Call LLM and validate response
    // ------------------------------------------------------------------
    const { parsed, modelUsed } = await callLlm(
      company,
      cfoScore,
      pipeSize,
      proFormaVal,
      spacTrustSize,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 6. Save to agent_results
    // ------------------------------------------------------------------
    await savePipeResult(
      input.taskId,
      companyId,
      parsed,
      approvedByHuman,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 7. Mark task completed
    // ------------------------------------------------------------------
    const result: PipeRunResult = {
      taskId:             input.taskId,
      companyId,
      companyName:        company.name,
      targetInvestors:    parsed.targetInvestors,
      pipeRecommendation: parsed.pipeRecommendation,
      investorTeaser:     parsed.investorTeaser,
      outreachStrategy:   parsed.outreachStrategy,
      pipeRoadmapSummary: parsed.pipeRoadmapSummary,
      reviewRequired:     true,
      approvedByHuman,
      modelUsed,
    };

    await supabase
      .from("agent_tasks")
      .update({
        status:       "completed",
        output:       result as unknown as Record<string, unknown>,
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    await supabase
      .from("agent_tasks")
      .update({ status: "failed", error, completed_at: nowIso() })
      .eq("id", input.taskId);

    throw err;
  }
}
