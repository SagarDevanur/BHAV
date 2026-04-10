/**
 * Redemption Agent — models SPAC shareholder redemption risk for a deSPAC target.
 *
 * OUTPUT (in one LLM call):
 *   1. redemptionForecast    — predicted rate (low/medium/high) with percentage range
 *   2. riskFactors           — deal-specific drivers of redemption pressure
 *   3. trustSizeRequirement  — minimum trust cash needed to close after redemptions
 *   4. mitigationStrategies  — extensions, sweeteners, PIPE sizing, and other levers
 *   5. comparableDeals       — redemption rates from similar sector deSPAC transactions
 *
 * This is a pure analysis agent — it takes no external actions regardless of
 * approvedByHuman. The flag is accepted and passed through to the LLM per the
 * system prompt contract, but does not gate execution.
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Writes agent_results row with result_type = "redemption"
 *
 * Input:  AgentInput — companyId at top level, optional deal params in payload
 * Output: RedemptionRunResult
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

// ---------------------------------------------------------------------------
// LLM clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

let _openai: OpenAI | null = null;
function getOpenAiClient(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error("OpenAI fallback unavailable: OPENAI_API_KEY is not set.");
  }
  if (!_openai) _openai = new OpenAI({ apiKey: config.openai.apiKey });
  return _openai;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SPAC_TRUST = "$150M";
const DEFAULT_PIPE_SIZE  = "[PLACEHOLDER]";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Predicted redemption rate bracket with a numeric percentage estimate. */
export interface RedemptionForecast {
  /** Qualitative risk level. */
  level: "low" | "medium" | "high" | "critical";
  /** Estimated redemption rate range, e.g. "60–75%". */
  estimatedRate: string;
  /** Narrative explanation of how the estimate was derived. */
  rationale: string;
  confidence: "low" | "medium" | "high";
}

/** A single mitigation action with expected impact and feasibility. */
export interface MitigationStrategy {
  action: string;
  category: "extension" | "sweetener" | "pipe" | "marketing" | "structural" | "other";
  expectedRedemptionReduction: string;
  feasibility: "easy" | "moderate" | "difficult";
  estimatedCost: string | null;
  timeline: string | null;
}

/** A comparable deSPAC deal used as a benchmark. */
export interface ComparableDeal {
  dealName: string;
  sector: string;
  closedYear: number | null;
  redemptionRate: string;
  trustSize: string | null;
  outcome: "completed" | "terminated" | "extended" | "unknown";
  relevanceNote: string;
}

export interface RedemptionRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  /** Predicted redemption rate with confidence and rationale. */
  redemptionForecast: RedemptionForecast;
  /** At least three deal-specific redemption risk drivers. */
  riskFactors: string[];
  /** Minimum cash in trust required post-redemption for the deal to close. */
  minimumViableCash: string;
  /** Plain-English deal viability assessment. */
  dealViabilityAssessment: string;
  /** Ranked list of mitigation strategies. */
  mitigationStrategies: MitigationStrategy[];
  /** Comparable deSPAC redemption rates from similar sector deals. */
  comparableDeals: ComparableDeal[];
  /** One-paragraph summary for the agent monitor. */
  analysisSummary: string;
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Raw LLM response — validated before use. */
interface LlmRedemptionResponse {
  companyId: string;
  redemptionForecast: RedemptionForecast;
  riskFactors: string[];
  minimumViableCash: string;
  dealViabilityAssessment: string;
  mitigationStrategies: MitigationStrategy[];
  comparableDeals: ComparableDeal[];
  analysisSummary: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_LEVELS      = new Set(["low", "medium", "high", "critical"]);
const VALID_CONFIDENCE  = new Set(["low", "medium", "high"]);
const VALID_FEASIBILITY = new Set(["easy", "moderate", "difficult"]);
const VALID_CATEGORIES  = new Set(["extension", "sweetener", "pipe", "marketing", "structural", "other"]);
const VALID_OUTCOMES    = new Set(["completed", "terminated", "extended", "unknown"]);

function validateLlmResponse(raw: unknown, fallbackId: string): LlmRedemptionResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Redemption agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  // redemptionForecast is the core output
  const rawForecast = (typeof r.redemptionForecast === "object" && r.redemptionForecast !== null)
    ? (r.redemptionForecast as Record<string, unknown>)
    : {};

  const forecastLevel = String(rawForecast.level ?? rawForecast.redemptionRiskLevel ?? "medium");
  const redemptionForecast: RedemptionForecast = {
    level:         (VALID_LEVELS.has(forecastLevel) ? forecastLevel : "medium") as RedemptionForecast["level"],
    estimatedRate: String(rawForecast.estimatedRate ?? rawForecast.estimatedRedemptionRate ?? "[PLACEHOLDER]"),
    rationale:     String(rawForecast.rationale ?? ""),
    confidence:    (VALID_CONFIDENCE.has(String(rawForecast.confidence))
      ? rawForecast.confidence
      : "medium") as RedemptionForecast["confidence"],
  };

  // riskFactors — at least three required by the system prompt
  const rawRiskFactors = Array.isArray(r.riskFactors)
    ? (r.riskFactors as string[])
    : Array.isArray(r.riskDrivers)
      ? (r.riskDrivers as string[])
      : [];

  const riskFactors = rawRiskFactors.length > 0
    ? rawRiskFactors
    : ["[PLACEHOLDER — risk factor 1]", "[PLACEHOLDER — risk factor 2]", "[PLACEHOLDER — risk factor 3]"];

  // mitigationStrategies — normalise each entry
  const rawMitigations = Array.isArray(r.mitigationStrategies)
    ? (r.mitigationStrategies as Record<string, unknown>[])
    : Array.isArray(r.mitigations)
      ? (r.mitigations as Record<string, unknown>[])
      : [];

  const mitigationStrategies: MitigationStrategy[] = rawMitigations.map((m) => {
    const cat = String(m.category ?? "other");
    const feas = String(m.feasibility ?? "moderate");
    return {
      action:                      String(m.action ?? ""),
      category:                    (VALID_CATEGORIES.has(cat) ? cat : "other") as MitigationStrategy["category"],
      expectedRedemptionReduction: String(m.expectedRedemptionReduction ?? m.expectedImpact ?? "[PLACEHOLDER]"),
      feasibility:                 (VALID_FEASIBILITY.has(feas) ? feas : "moderate") as MitigationStrategy["feasibility"],
      estimatedCost:               m.estimatedCost != null ? String(m.estimatedCost) : null,
      timeline:                    m.timeline      != null ? String(m.timeline)      : null,
    };
  });

  // comparableDeals — normalise each entry
  const rawComparables = Array.isArray(r.comparableDeals)
    ? (r.comparableDeals as Record<string, unknown>[])
    : Array.isArray(r.comparableRedemptionRates)
      ? (r.comparableRedemptionRates as Record<string, unknown>[])
      : [];

  const comparableDeals: ComparableDeal[] = rawComparables.map((c) => {
    const outcome = String(c.outcome ?? "unknown");
    const year = c.closedYear != null ? Number(c.closedYear) : null;
    return {
      dealName:       String(c.dealName ?? c.deal_name ?? "[Unknown deal]"),
      sector:         String(c.sector ?? ""),
      closedYear:     !isNaN(year ?? NaN) ? year : null,
      redemptionRate: String(c.redemptionRate ?? c.redemption_rate ?? "[PLACEHOLDER]"),
      trustSize:      c.trustSize != null ? String(c.trustSize) : null,
      outcome:        (VALID_OUTCOMES.has(outcome) ? outcome : "unknown") as ComparableDeal["outcome"],
      relevanceNote:  String(c.relevanceNote ?? c.rationale ?? ""),
    };
  });

  return {
    companyId:               String(r.companyId ?? fallbackId),
    redemptionForecast,
    riskFactors,
    minimumViableCash:       String(r.minimumViableCash ?? "[PLACEHOLDER]"),
    dealViabilityAssessment: String(r.dealViabilityAssessment ?? ""),
    mitigationStrategies,
    comparableDeals,
    analysisSummary:         String(r.analysisSummary ?? r.summary ?? ""),
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
  spacTrustSize: string,
  pipeSize: string,
  dealPremium: string | null,
  marketConditions: string | null,
  approvedByHuman: boolean
): Promise<{ parsed: LlmRedemptionResponse; modelUsed: string }> {
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
    cfo_rationale:       cfoScore?.rationale       ?? null,
    cfo_recommendation:  cfoScore?.recommendation  ?? null,
    dealParameters: {
      proFormaValuation: company.estimated_valuation ?? "[PLACEHOLDER]",
      spac_trust_size:   spacTrustSize,
      pipeSize,
      dealPremium:       dealPremium ?? null,
    },
    marketConditions:           marketConditions ?? null,
    comparableRedemptionRates:  null,
    approvedByHuman,
    instructions:
      "Produce a complete SPAC redemption risk analysis in a single JSON response with these exact keys: " +
      "companyId, " +
      "redemptionForecast (object: level ('low'|'medium'|'high'|'critical'), estimatedRate (string e.g. '60–75%'), rationale, confidence ('low'|'medium'|'high')), " +
      "riskFactors (string[], minimum 3 deal-specific drivers), " +
      "minimumViableCash (string — minimum trust cash needed post-redemption for deal to close), " +
      "dealViabilityAssessment (string — plain-English viability verdict), " +
      "mitigationStrategies (array of objects: action, category ('extension'|'sweetener'|'pipe'|'marketing'|'structural'|'other'), " +
      "expectedRedemptionReduction, feasibility ('easy'|'moderate'|'difficult'), estimatedCost (string|null), timeline (string|null)), " +
      "comparableDeals (array of objects: dealName, sector, closedYear (number|null), redemptionRate, trustSize (string|null), " +
      "outcome ('completed'|'terminated'|'extended'|'unknown'), relevanceNote), " +
      "analysisSummary (one-paragraph plain-text summary). " +
      "If estimated redemption exceeds 80%, flag the deal as critical risk. " +
      "Populate riskFactors with at least 3 factors. Use [PLACEHOLDER] for unavailable figures.",
  });

  let responseText: string;
  let modelUsed: string;

  try {
    const message = await anthropic.messages.create({
      model:      config.anthropic.model,
      max_tokens: 4096,
      system:     AGENT_PROMPTS.redemption,
      messages:   [{ role: "user", content: userMessage }],
    });

    if (message.content[0].type !== "text") {
      throw new Error("Claude returned a non-text content block");
    }

    responseText = message.content[0].text;
    modelUsed    = config.anthropic.model;
  } catch (claudeErr) {
    console.error("[Redemption agent] Anthropic API error:", claudeErr);
    if (!config.openai.apiKey) throw claudeErr;

    const claudeMessage =
      claudeErr instanceof Error ? claudeErr.message : String(claudeErr);

    const completion = await getOpenAiClient().chat.completions.create({
      model:           config.openai.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AGENT_PROMPTS.redemption },
        { role: "user",   content: userMessage },
      ],
    });

    responseText = completion.choices[0]?.message?.content ?? "{}";
    modelUsed    = `${config.openai.model} (fallback — Claude error: ${claudeMessage})`;
  }

  // Strip markdown code fences if the model wrapped its response
  const jsonText = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: LlmRedemptionResponse;
  try {
    parsed = validateLlmResponse(JSON.parse(jsonText), company.id);
  } catch {
    throw new Error(
      `Redemption agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

async function saveRedemptionResult(
  taskId: string,
  companyId: string,
  parsed: LlmRedemptionResponse,
  approvedByHuman: boolean,
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "redemption",
    result_type: "redemption",
    content: {
      redemptionForecast:      parsed.redemptionForecast,
      riskFactors:             parsed.riskFactors,
      minimumViableCash:       parsed.minimumViableCash,
      dealViabilityAssessment: parsed.dealViabilityAssessment,
      mitigationStrategies:    parsed.mitigationStrategies,
      comparableDeals:         parsed.comparableDeals,
      analysisSummary:         parsed.analysisSummary,
      approvedByHuman,
      modelUsed,
      analyzedAt:              nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    throw new Error(`Failed to save redemption result to agent_results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Redemption agent to model SPAC shareholder redemption risk.
 *
 * Flow:
 *   1. Mark agent_tasks row as running.
 *   2. Fetch company record and CFO score breakdown in parallel.
 *   3. Call Claude requesting all five analysis components in one response; fall back to OpenAI.
 *   4. Validate LLM response — normalise all fields with safe defaults.
 *   5. Save full analysis to agent_results (result_type = "redemption").
 *   6. Mark agent_tasks completed (or failed on any error).
 *   7. Return RedemptionRunResult for dashboard display.
 *
 * No external actions are taken by this agent regardless of approvedByHuman.
 * The flag is accepted and passed to the LLM per the system prompt contract.
 *
 * @param input - AgentInput; companyId at top level, optional deal params in payload
 * @returns     RedemptionRunResult with full redemption risk analysis
 * @throws      On LLM or DB errors
 */
export async function runRedemptionAgent(input: AgentInput): Promise<RedemptionRunResult> {
  const supabase        = createAdminClient();
  const companyId       = input.companyId ?? String((input.payload ?? {}).companyId ?? "");
  const approvedByHuman = input.approvedByHuman === true;

  if (!companyId) {
    throw new Error("Redemption agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: nowIso() })
    .eq("id", input.taskId);

  try {
    // ------------------------------------------------------------------
    // 2. Fetch company and CFO score in parallel
    // ------------------------------------------------------------------
    const [company, cfoScore] = await Promise.all([
      fetchCompany(companyId),
      fetchCfoScore(companyId),
    ]);

    // Optional caller overrides
    const payload          = input.payload ?? {};
    const spacTrustSize    = typeof payload.spac_trust_size   === "string" ? payload.spac_trust_size   : DEFAULT_SPAC_TRUST;
    const pipeSize         = typeof payload.pipeSize          === "string" ? payload.pipeSize          : DEFAULT_PIPE_SIZE;
    const dealPremium      = typeof payload.dealPremium       === "string" ? payload.dealPremium       : null;
    const marketConditions = typeof payload.marketConditions  === "string" ? payload.marketConditions  : null;

    // ------------------------------------------------------------------
    // 3 + 4. Call LLM and validate response
    // ------------------------------------------------------------------
    const { parsed, modelUsed } = await callLlm(
      company,
      cfoScore,
      spacTrustSize,
      pipeSize,
      dealPremium,
      marketConditions,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 5. Save to agent_results
    // ------------------------------------------------------------------
    await saveRedemptionResult(
      input.taskId,
      companyId,
      parsed,
      approvedByHuman,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 6. Mark task completed
    // ------------------------------------------------------------------
    const result: RedemptionRunResult = {
      taskId:                  input.taskId,
      companyId,
      companyName:             company.name,
      redemptionForecast:      parsed.redemptionForecast,
      riskFactors:             parsed.riskFactors,
      minimumViableCash:       parsed.minimumViableCash,
      dealViabilityAssessment: parsed.dealViabilityAssessment,
      mitigationStrategies:    parsed.mitigationStrategies,
      comparableDeals:         parsed.comparableDeals,
      analysisSummary:         parsed.analysisSummary,
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
