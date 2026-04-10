/**
 * Structuring Agent — designs the optimal deSPAC transaction structure for a target.
 *
 * DOCUMENTS PRODUCED (in one LLM call):
 *   1. recommendedStructure — Up-C, traditional merger, or direct listing with rationale
 *   2. earnoutProvisions    — milestones, hurdles, and payment schedule
 *   3. sponsorEconomics     — promote structure, alignment, and fee arrangements
 *   4. valuationRange       — low, mid, and high case with assumptions
 *   5. keyDealTerms         — lock-up periods, redemption rights, voting structure
 *
 * HUMAN APPROVAL GATE:
 *   - approvedByHuman: false → task marked failed; nothing is produced
 *   - approvedByHuman: true  → full structure is produced and saved; never executed by this agent
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Writes agent_results row with result_type = "structuring"
 *
 * Input:  AgentInput — companyId at top level, optional co-founder preferences in payload
 * Output: StructuringRunResult
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

const BHAV_SPAC_NAME     = "BHAV Acquisition Corp";
const DEFAULT_SPAC_TRUST = "$150M";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Earnout milestone as returned by the LLM. */
export interface EarnoutMilestone {
  description: string;
  metric: string;
  threshold: string;
  paymentAmount: string;
  deadlineMonths: number;
}

/** Valuation case — low, mid, or high. */
export interface ValuationCase {
  label: "low" | "mid" | "high";
  enterpriseValue: string;
  equityValue: string;
  revenueMultiple: string;
  keyAssumptions: string[];
}

/** Lock-up, redemption, and voting terms. */
export interface KeyDealTerms {
  lockupPeriods: {
    founders: string;
    sponsor: string;
    target_shareholders: string;
  };
  redemptionRights: string;
  votingStructure: string;
  noShopPeriodDays: number;
  additionalTerms: string[];
}

export interface StructuringRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  /** Primary structure recommendation — Up-C, traditional merger, or direct listing. */
  recommendedStructure: {
    mergerType: string;
    proFormaValuation: string;
    enterpriseValue: string;
    equityConsideration: string;
    cashConsideration: string;
    pipeSize: string;
    pipeTerms: string | null;
    lockupPeriods: Record<string, string>;
    earnout: Record<string, unknown> | null;
    rationale: string;
  };
  /** Alternative structures considered. */
  alternativeStructures: Record<string, unknown>[];
  /** Earnout provisions — milestones and payment schedule. */
  earnoutProvisions: EarnoutMilestone[];
  /** Sponsor economics — promote structure and alignment. */
  sponsorEconomics: {
    promoteStructure: string;
    promotePercentage: string;
    vestingSchedule: string;
    alignmentMechanisms: string[];
    fees: string;
  };
  /** Low, mid, and high valuation cases. */
  valuationRange: ValuationCase[];
  /** Lock-up periods, redemption rights, and voting structure. */
  keyDealTerms: KeyDealTerms;
  /** Deal-level risks flagged by the agent. */
  risks: string[];
  /** One-paragraph rationale summary. */
  rationale: string;
  /** Always true — structure must be reviewed before any execution step. */
  reviewRequired: true;
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Raw LLM response shape — validated before use. */
interface LlmStructuringResponse {
  companyId: string;
  recommendedStructure: StructuringRunResult["recommendedStructure"];
  alternativeStructures: Record<string, unknown>[];
  earnoutProvisions: EarnoutMilestone[];
  sponsorEconomics: StructuringRunResult["sponsorEconomics"];
  valuationRange: ValuationCase[];
  keyDealTerms: KeyDealTerms;
  risks: string[];
  rationale: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateLlmResponse(raw: unknown, fallbackId: string): LlmStructuringResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Structuring agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  // recommendedStructure is the core output — must be present
  if (typeof r.recommendedStructure !== "object" || r.recommendedStructure === null) {
    throw new Error("Structuring agent returned no recommendedStructure");
  }

  const rs = r.recommendedStructure as Record<string, unknown>;
  if (!String(rs.mergerType ?? "").trim()) {
    throw new Error("Structuring agent recommendedStructure is missing mergerType");
  }

  return {
    companyId:            String(r.companyId ?? fallbackId),
    recommendedStructure: r.recommendedStructure as LlmStructuringResponse["recommendedStructure"],
    alternativeStructures: Array.isArray(r.alternativeStructures)
      ? (r.alternativeStructures as Record<string, unknown>[])
      : [],
    earnoutProvisions: Array.isArray(r.earnoutProvisions)
      ? (r.earnoutProvisions as EarnoutMilestone[])
      : [],
    sponsorEconomics: (typeof r.sponsorEconomics === "object" && r.sponsorEconomics !== null)
      ? (r.sponsorEconomics as LlmStructuringResponse["sponsorEconomics"])
      : {
          promoteStructure:    "[PLACEHOLDER]",
          promotePercentage:   "[PLACEHOLDER]",
          vestingSchedule:     "[PLACEHOLDER]",
          alignmentMechanisms: [],
          fees:                "[PLACEHOLDER]",
        },
    valuationRange: Array.isArray(r.valuationRange)
      ? (r.valuationRange as ValuationCase[])
      : [],
    keyDealTerms: (typeof r.keyDealTerms === "object" && r.keyDealTerms !== null)
      ? (r.keyDealTerms as KeyDealTerms)
      : {
          lockupPeriods:      { founders: "[PLACEHOLDER]", sponsor: "[PLACEHOLDER]", target_shareholders: "[PLACEHOLDER]" },
          redemptionRights:   "[PLACEHOLDER]",
          votingStructure:    "[PLACEHOLDER]",
          noShopPeriodDays:   45,
          additionalTerms:    [],
        },
    risks:     Array.isArray(r.risks)    ? (r.risks    as string[]) : [],
    rationale: String(r.rationale ?? ""),
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
// Co-founder preference defaults
// ---------------------------------------------------------------------------

interface CoFounderPreferences {
  maxDilution: string | null;
  earnoutPreference: boolean;
  pipeTarget: string | null;
}

function buildCoFounderPreferences(
  payload: Record<string, unknown> | undefined
): CoFounderPreferences {
  const prefs = (payload?.coFounderPreferences ?? {}) as Record<string, unknown>;
  return {
    maxDilution:       typeof prefs.maxDilution === "string" ? prefs.maxDilution : null,
    earnoutPreference: prefs.earnoutPreference === true,
    pipeTarget:        typeof prefs.pipeTarget  === "string" ? prefs.pipeTarget  : null,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(
  company: CompanyRow,
  cfoScore: CfoScoreContent | null,
  coFounderPreferences: CoFounderPreferences,
  spacTrustSize: string,
  approvedByHuman: boolean
): Promise<{ parsed: LlmStructuringResponse; modelUsed: string }> {
  const userMessage = JSON.stringify({
    companyId:           company.id,
    companyName:         company.name,
    estimated_valuation: company.estimated_valuation,
    estimated_revenue:   null, // not stored on companies — passed as [PLACEHOLDER]
    sector:              company.sector,
    sub_sector:          company.sub_sector,
    blurb:               company.blurb,
    last_round:          company.last_round,
    despac_score:        company.despac_score ?? cfoScore?.despac_score ?? null,
    cfo_score_breakdown: cfoScore?.score_breakdown ?? null,
    cfo_rationale:       cfoScore?.rationale       ?? null,
    cfo_recommendation:  cfoScore?.recommendation  ?? null,
    spac_name:           BHAV_SPAC_NAME,
    spac_trust_size:     spacTrustSize,
    co_founder_preferences: coFounderPreferences,
    approvedByHuman,
    structuresToEvaluate: [
      "Up-C (pass-through entity)",
      "traditional forward triangular merger",
      "direct deSPAC merger",
    ],
    instructions:
      "Design the optimal deSPAC transaction structure. " +
      "Return a single JSON object with these exact keys: " +
      "companyId, recommendedStructure (object matching the Structuring Agent OUTPUT schema), " +
      "alternativeStructures (array of at least one alternative), " +
      "earnoutProvisions (array of milestone objects: description, metric, threshold, paymentAmount, deadlineMonths), " +
      "sponsorEconomics (object: promoteStructure, promotePercentage, vestingSchedule, alignmentMechanisms[], fees), " +
      "valuationRange (array of three objects with label low/mid/high: enterpriseValue, equityValue, revenueMultiple, keyAssumptions[]), " +
      "keyDealTerms (object: lockupPeriods{founders,sponsor,target_shareholders}, redemptionRights, votingStructure, noShopPeriodDays, additionalTerms[]), " +
      "risks (string[]), rationale (string). " +
      "Use [PLACEHOLDER] for any missing figures. Flag items requiring legal sign-off in risks.",
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 6144,
    system:     AGENT_PROMPTS.structuring,
    messages:   [{ role: "user", content: userMessage }],
  });

  if (message.content[0].type !== "text") {
    throw new Error("Claude returned a non-text content block");
  }

  const responseText = message.content[0].text;
  const modelUsed    = config.anthropic.model;

  // Strip markdown code fences if the model wrapped its response
  const jsonText = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: LlmStructuringResponse;
  try {
    parsed = validateLlmResponse(JSON.parse(jsonText), company.id);
  } catch {
    throw new Error(
      `Structuring agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

async function saveStructuringResult(
  taskId: string,
  companyId: string,
  parsed: LlmStructuringResponse,
  approvedByHuman: boolean,
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "structuring",
    result_type: "structuring",
    content: {
      recommendedStructure:  parsed.recommendedStructure,
      alternativeStructures: parsed.alternativeStructures,
      earnoutProvisions:     parsed.earnoutProvisions,
      sponsorEconomics:      parsed.sponsorEconomics,
      valuationRange:        parsed.valuationRange,
      keyDealTerms:          parsed.keyDealTerms,
      risks:                 parsed.risks,
      rationale:             parsed.rationale,
      reviewRequired:        true,
      approvedByHuman,
      modelUsed,
      structuredAt:          nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    throw new Error(`Failed to save structuring result to agent_results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Structuring agent to design a full deSPAC deal structure.
 *
 * Flow:
 *   1. Enforce the human approval gate — mark failed and throw if not approved.
 *   2. Mark agent_tasks row as running.
 *   3. Fetch company record and CFO score breakdown in parallel.
 *   4. Build co-founder preferences from payload (with safe defaults).
 *   5. Call Claude requesting all five structure components in one response; fall back to OpenAI.
 *   6. Validate LLM response — recommendedStructure with mergerType must be present.
 *   7. Save full structure to agent_results (result_type = "structuring").
 *   8. Mark agent_tasks completed (or failed on any error).
 *   9. Return StructuringRunResult with all components for dashboard display.
 *
 * @param input - AgentInput; companyId at top level, optional prefs in payload.coFounderPreferences
 * @returns     StructuringRunResult with full deal structure
 * @throws      If approvedByHuman is false/absent, or on LLM / DB errors
 */
export async function runStructuringAgent(input: AgentInput): Promise<StructuringRunResult> {
  const supabase        = createAdminClient();
  const companyId       = input.companyId ?? String((input.payload ?? {}).companyId ?? "");
  const approvedByHuman = input.approvedByHuman === true;

  if (!companyId) {
    throw new Error("Structuring agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Human approval gate
  // ------------------------------------------------------------------
  if (!approvedByHuman) {
    await supabase
      .from("agent_tasks")
      .update({
        status:       "failed",
        error:        "Structuring agent requires approvedByHuman: true. Set this flag to authorise deal structuring.",
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    throw new Error(
      "Structuring agent requires approvedByHuman: true. " +
        "Ensure a co-founder has explicitly approved before dispatching the Structuring agent."
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

    // ------------------------------------------------------------------
    // 4. Build co-founder preferences and SPAC trust size
    // ------------------------------------------------------------------
    const coFounderPreferences = buildCoFounderPreferences(input.payload);
    const spacTrustSize = String(
      (input.payload ?? {}).spac_trust_size ?? DEFAULT_SPAC_TRUST
    );

    // ------------------------------------------------------------------
    // 5 + 6. Call LLM and validate response
    // ------------------------------------------------------------------
    const { parsed, modelUsed } = await callLlm(
      company,
      cfoScore,
      coFounderPreferences,
      spacTrustSize,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 7. Save to agent_results
    // ------------------------------------------------------------------
    await saveStructuringResult(
      input.taskId,
      companyId,
      parsed,
      approvedByHuman,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 8. Mark task completed
    // ------------------------------------------------------------------
    const result: StructuringRunResult = {
      taskId:               input.taskId,
      companyId,
      companyName:          company.name,
      recommendedStructure: parsed.recommendedStructure,
      alternativeStructures: parsed.alternativeStructures,
      earnoutProvisions:    parsed.earnoutProvisions,
      sponsorEconomics:     parsed.sponsorEconomics,
      valuationRange:       parsed.valuationRange,
      keyDealTerms:         parsed.keyDealTerms,
      risks:                parsed.risks,
      rationale:            parsed.rationale,
      reviewRequired:       true,
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
