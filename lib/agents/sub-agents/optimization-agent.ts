/**
 * Optimization Agent — synthesises all prior agent outputs into a final deal
 * optimisation report for a deSPAC target.
 *
 * PRIOR AGENT OUTPUTS CONSUMED (fetched from agent_results):
 *   - cfo        → score breakdown and financial rationale
 *   - structuring → recommended deal structure, valuation range, earnout terms
 *   - pipe        → PIPE sizing recommendation, investor targeting
 *   - redemption  → redemption forecast, mitigation strategies
 *
 * OUTPUT (one LLM call):
 *   1. valuationAdjustment    — recommended valuation change based on PIPE + redemption signals
 *   2. structureTweaks        — targeted changes to improve completion probability
 *   3. timingRecommendation   — optimal announcement window with rationale
 *   4. riskMitigationActions  — ranked priority actions across all risk dimensions
 *   5. goNoGo                 — final recommendation with confidence score (0–100)
 *
 * This is a pure analysis agent — no external actions are taken.
 * approvedByHuman is accepted and passed through to the LLM but does not gate execution.
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Writes agent_results row with result_type = "optimization"
 *
 * Input:  AgentInput — companyId at top level
 * Output: OptimizationRunResult
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
// Types
// ---------------------------------------------------------------------------

/** A single recommended adjustment with impact estimate and priority. */
export interface OptimizationItem {
  area: string;
  currentState: string;
  recommendation: string;
  expectedImpact: string;
  priority: "low" | "medium" | "high";
}

/** Valuation adjustment recommendation. */
export interface ValuationAdjustment {
  currentValuation: string;
  recommendedValuation: string;
  /** Direction and magnitude, e.g. "−10% to −15%". */
  adjustmentRange: string;
  rationale: string;
  /** Key signals driving this adjustment. */
  signals: string[];
}

/** Timing recommendation with an optimal announcement window. */
export interface TimingRecommendation {
  /** Plain-English description of the optimal window, e.g. "Q1 2026, post-rate decision". */
  optimalWindow: string;
  rationale: string;
  /** Risks of announcing too early. */
  risksOfDelay: string[];
  /** Risks of waiting too long. */
  risksOfHaste: string[];
}

/** Final go / no-go verdict. */
export interface GoNoGo {
  decision: "go" | "conditional_go" | "no_go";
  /** Confidence in the decision, 0–100. */
  confidenceScore: number;
  rationale: string;
  /** Conditions that must be met for a conditional_go to become a go. */
  conditions: string[];
  /** Critical blockers for a no_go. */
  blockers: string[];
}

export interface OptimizationRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  /** Recommended valuation adjustment from PIPE + redemption signals. */
  valuationAdjustment: ValuationAdjustment;
  /** Targeted deal structure tweaks to maximise completion probability. */
  structureTweaks: OptimizationItem[];
  /** Optimal announcement timing with rationale. */
  timingRecommendation: TimingRecommendation;
  /** All risk mitigation actions ranked by priority. */
  riskMitigationActions: OptimizationItem[];
  /** Estimated improvement in deal close probability. */
  closeProbabilityDelta: string;
  /** Final go / no-go recommendation with confidence score. */
  goNoGo: GoNoGo;
  /** One-paragraph plain-text summary for the monitor view. */
  summary: string;
  /** Which prior agent results were available for synthesis. */
  priorResultsUsed: string[];
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Raw LLM response — validated before use. */
interface LlmOptimizationResponse {
  companyId: string;
  valuationAdjustment: ValuationAdjustment;
  structureTweaks: OptimizationItem[];
  timingRecommendation: TimingRecommendation;
  riskMitigationActions: OptimizationItem[];
  closeProbabilityDelta: string;
  goNoGo: GoNoGo;
  summary: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_PRIORITY  = new Set(["low", "medium", "high"]);
const VALID_DECISIONS = new Set(["go", "conditional_go", "no_go"]);

function normaliseItem(raw: Record<string, unknown>, idx: number): OptimizationItem {
  const p = String(raw.priority ?? "medium");
  return {
    area:           String(raw.area            ?? `Area ${idx + 1}`),
    currentState:   String(raw.currentState    ?? raw.current_state ?? ""),
    recommendation: String(raw.recommendation  ?? ""),
    expectedImpact: String(raw.expectedImpact  ?? raw.expected_impact ?? ""),
    priority:       (VALID_PRIORITY.has(p) ? p : "medium") as OptimizationItem["priority"],
  };
}

function validateLlmResponse(raw: unknown, fallbackId: string): LlmOptimizationResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Optimization agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  // ---- valuationAdjustment ----
  const rawVal = (typeof r.valuationAdjustment === "object" && r.valuationAdjustment !== null)
    ? (r.valuationAdjustment as Record<string, unknown>)
    : {};
  const valuationAdjustment: ValuationAdjustment = {
    currentValuation:     String(rawVal.currentValuation     ?? rawVal.current_valuation    ?? "[PLACEHOLDER]"),
    recommendedValuation: String(rawVal.recommendedValuation ?? rawVal.revised_valuation    ?? "[PLACEHOLDER]"),
    adjustmentRange:      String(rawVal.adjustmentRange      ?? rawVal.adjustment_range     ?? "[PLACEHOLDER]"),
    rationale:            String(rawVal.rationale            ?? ""),
    signals:              Array.isArray(rawVal.signals) ? (rawVal.signals as string[]) : [],
  };

  // ---- structureTweaks ----
  const rawTweaks = Array.isArray(r.structureTweaks)
    ? (r.structureTweaks as Record<string, unknown>[])
    : Array.isArray(r.revisedStructureSuggestion)
      ? (r.revisedStructureSuggestion as Record<string, unknown>[])
      : [];
  const structureTweaks = rawTweaks.map(normaliseItem);

  // ---- timingRecommendation ----
  const rawTiming = (typeof r.timingRecommendation === "object" && r.timingRecommendation !== null)
    ? (r.timingRecommendation as Record<string, unknown>)
    : {};
  const timingRecommendation: TimingRecommendation = {
    optimalWindow:  String(rawTiming.optimalWindow  ?? rawTiming.optimal_window  ?? "[PLACEHOLDER]"),
    rationale:      String(rawTiming.rationale      ?? ""),
    risksOfDelay:   Array.isArray(rawTiming.risksOfDelay)  ? (rawTiming.risksOfDelay  as string[]) : [],
    risksOfHaste:   Array.isArray(rawTiming.risksOfHaste)  ? (rawTiming.risksOfHaste  as string[]) : [],
  };

  // ---- riskMitigationActions ----
  const rawActions = Array.isArray(r.riskMitigationActions)
    ? (r.riskMitigationActions as Record<string, unknown>[])
    : Array.isArray(r.optimizations)
      ? (r.optimizations as Record<string, unknown>[])
      : [];
  const riskMitigationActions = rawActions.map(normaliseItem);

  // ---- goNoGo ----
  const rawGng = (typeof r.goNoGo === "object" && r.goNoGo !== null)
    ? (r.goNoGo as Record<string, unknown>)
    : {};
  const decision = String(rawGng.decision ?? "conditional_go");
  const rawConfidence = Number(rawGng.confidenceScore ?? rawGng.confidence_score ?? 50);
  const goNoGo: GoNoGo = {
    decision:        (VALID_DECISIONS.has(decision) ? decision : "conditional_go") as GoNoGo["decision"],
    confidenceScore: Math.min(100, Math.max(0, isNaN(rawConfidence) ? 50 : rawConfidence)),
    rationale:       String(rawGng.rationale ?? ""),
    conditions:      Array.isArray(rawGng.conditions) ? (rawGng.conditions as string[]) : [],
    blockers:        Array.isArray(rawGng.blockers)   ? (rawGng.blockers   as string[]) : [],
  };

  return {
    companyId:             String(r.companyId ?? fallbackId),
    valuationAdjustment,
    structureTweaks,
    timingRecommendation,
    riskMitigationActions,
    closeProbabilityDelta: String(r.closeProbabilityDelta ?? r.close_probability_delta ?? "[PLACEHOLDER]"),
    goNoGo,
    summary:               String(r.summary ?? ""),
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
 * Fetches the most recent result from agent_results for a given agent name.
 * Returns null (and notes the gap) if no result exists — the LLM is told which
 * prior agents have run so it can calibrate its analysis appropriately.
 */
async function fetchLatestAgentResult(
  companyId: string,
  agentName: string
): Promise<Record<string, unknown> | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_results")
    .select("content")
    .eq("company_id", companyId)
    .eq("agent_name", agentName)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return null;

  const row = data[0] as { content: unknown };
  if (typeof row.content !== "object" || row.content === null) return null;

  return row.content as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(
  company: CompanyRow,
  cfoResult: Record<string, unknown> | null,
  structuringResult: Record<string, unknown> | null,
  pipeResult: Record<string, unknown> | null,
  redemptionResult: Record<string, unknown> | null,
  approvedByHuman: boolean
): Promise<{ parsed: LlmOptimizationResponse; modelUsed: string }> {
  // Track which prior agents contributed to give the LLM full context
  const priorResultsUsed: string[] = [
    ...(cfoResult        ? ["cfo"]         : []),
    ...(structuringResult ? ["structuring"] : []),
    ...(pipeResult        ? ["pipe"]        : []),
    ...(redemptionResult  ? ["redemption"]  : []),
  ];

  const userMessage = JSON.stringify({
    companyId:           company.id,
    companyName:         company.name,
    sector:              company.sector,
    sub_sector:          company.sub_sector,
    blurb:               company.blurb,
    estimated_valuation: company.estimated_valuation,
    despac_score:        company.despac_score,
    priorResultsAvailable: priorResultsUsed,
    // Prior agent outputs — null when not yet run
    cfoResult,
    currentStructure:    structuringResult?.recommendedStructure   ?? structuringResult ?? null,
    pipeAnalysis:        pipeResult                               ?? null,
    redemptionAnalysis:  redemptionResult                         ?? null,
    marketConditions:    null,
    comparableDeals:     null,
    approvedByHuman,
    instructions:
      "Synthesise all prior agent outputs into a final deal optimisation report. " +
      "Return a single JSON object with these exact keys: " +
      "companyId, " +
      "valuationAdjustment (object: currentValuation, recommendedValuation, adjustmentRange, rationale, signals[]), " +
      "structureTweaks (array of objects: area, currentState, recommendation, expectedImpact, priority ('low'|'medium'|'high')), " +
      "timingRecommendation (object: optimalWindow, rationale, risksOfDelay[], risksOfHaste[]), " +
      "riskMitigationActions (array of objects same shape as structureTweaks, sorted by priority descending), " +
      "closeProbabilityDelta (string e.g. '+12–18%'), " +
      "goNoGo (object: decision ('go'|'conditional_go'|'no_go'), confidenceScore (integer 0–100), " +
      "rationale, conditions[], blockers[]), " +
      "summary (one-paragraph plain-text synthesis for the monitor view). " +
      "Where prior agent results are null, note the gap and make conservative assumptions. " +
      "Prioritise redemption risk reduction above all other optimisations. " +
      "Use [PLACEHOLDER] for figures not derivable from the inputs provided.",
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 6144,
    system:     AGENT_PROMPTS.optimization,
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

  let parsed: LlmOptimizationResponse;
  try {
    parsed = validateLlmResponse(JSON.parse(jsonText), company.id);
  } catch {
    throw new Error(
      `Optimization agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

async function saveOptimizationResult(
  taskId: string,
  companyId: string,
  parsed: LlmOptimizationResponse,
  priorResultsUsed: string[],
  approvedByHuman: boolean,
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "optimization",
    result_type: "optimization",
    content: {
      valuationAdjustment:    parsed.valuationAdjustment,
      structureTweaks:        parsed.structureTweaks,
      timingRecommendation:   parsed.timingRecommendation,
      riskMitigationActions:  parsed.riskMitigationActions,
      closeProbabilityDelta:  parsed.closeProbabilityDelta,
      goNoGo:                 parsed.goNoGo,
      summary:                parsed.summary,
      priorResultsUsed,
      approvedByHuman,
      modelUsed,
      optimizedAt:            nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    throw new Error(`Failed to save optimization result to agent_results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Optimization agent to produce a final deal optimisation report.
 *
 * Flow:
 *   1. Mark agent_tasks row as running.
 *   2. Fetch company record and the four prior agent results in parallel.
 *      Missing results are passed as null — the LLM is told which are absent.
 *   3. Call Claude with all prior outputs; fall back to OpenAI on failure.
 *   4. Validate LLM response — normalise all fields with safe defaults.
 *   5. Save full report to agent_results (result_type = "optimization").
 *   6. Mark agent_tasks completed (or failed on any error).
 *   7. Return OptimizationRunResult for dashboard display.
 *
 * No external actions are taken by this agent regardless of approvedByHuman.
 *
 * @param input - AgentInput; companyId at top level
 * @returns     OptimizationRunResult with full optimisation report
 * @throws      On LLM or DB errors
 */
export async function runOptimizationAgent(input: AgentInput): Promise<OptimizationRunResult> {
  const supabase        = createAdminClient();
  const companyId       = input.companyId ?? String((input.payload ?? {}).companyId ?? "");
  const approvedByHuman = input.approvedByHuman === true;

  if (!companyId) {
    throw new Error("Optimization agent requires a companyId");
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
    // 2. Fetch company + all four prior agent results in parallel
    // ------------------------------------------------------------------
    const [
      company,
      cfoResult,
      structuringResult,
      pipeResult,
      redemptionResult,
    ] = await Promise.all([
      fetchCompany(companyId),
      fetchLatestAgentResult(companyId, "cfo"),
      fetchLatestAgentResult(companyId, "structuring"),
      fetchLatestAgentResult(companyId, "pipe"),
      fetchLatestAgentResult(companyId, "redemption"),
    ]);

    const priorResultsUsed: string[] = [
      ...(cfoResult         ? ["cfo"]         : []),
      ...(structuringResult ? ["structuring"]  : []),
      ...(pipeResult        ? ["pipe"]         : []),
      ...(redemptionResult  ? ["redemption"]   : []),
    ];

    // ------------------------------------------------------------------
    // 3 + 4. Call LLM and validate response
    // ------------------------------------------------------------------
    const { parsed, modelUsed } = await callLlm(
      company,
      cfoResult,
      structuringResult,
      pipeResult,
      redemptionResult,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 5. Save to agent_results
    // ------------------------------------------------------------------
    await saveOptimizationResult(
      input.taskId,
      companyId,
      parsed,
      priorResultsUsed,
      approvedByHuman,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 6. Mark task completed
    // ------------------------------------------------------------------
    const result: OptimizationRunResult = {
      taskId:                input.taskId,
      companyId,
      companyName:           company.name,
      valuationAdjustment:   parsed.valuationAdjustment,
      structureTweaks:       parsed.structureTweaks,
      timingRecommendation:  parsed.timingRecommendation,
      riskMitigationActions: parsed.riskMitigationActions,
      closeProbabilityDelta: parsed.closeProbabilityDelta,
      goNoGo:                parsed.goNoGo,
      summary:               parsed.summary,
      priorResultsUsed,
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
