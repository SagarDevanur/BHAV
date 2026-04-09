/**
 * Master Agent — the sole dispatcher of sub-agent jobs.
 *
 * Receives a CEO directive (via BullMQ or the API route), calls Claude to
 * produce a human-readable execution plan, then runs deterministic fanout
 * logic for each supported task type.
 *
 * Supported task types (matched from ceoOutput.action):
 *   score_companies   — dispatch a CFO job for every unscored company
 *   enrich_contacts   — dispatch a contact job for every company with no contacts
 *   source_targets    — dispatch one sourcing job
 *   draft_loi         — dispatch an LOI job for a specific company (approvedByHuman required)
 *   outreach_pipe     — dispatch outreach + pipe jobs for a company (approvedByHuman required)
 *
 * Input:  AgentInput (payload.ceoOutput carries the CEO directive)
 * Output: MasterRunResult
 *
 * Side effects:
 *   - Updates the master agent_tasks row (running → completed | failed)
 *   - dispatchAgentJob() creates child agent_tasks rows for each dispatched job
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "./prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchAgentJob } from "@/lib/queue/dispatcher";
import type { DispatchResult } from "@/lib/queue/dispatcher";
import type { AgentInput } from "@/types/agents";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max companies processed per score_companies or enrich_contacts run. */
const BATCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// LLM clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

let _openai: OpenAI | null = null;
function getOpenAiClient(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error(
      "OpenAI fallback unavailable: OPENAI_API_KEY is not set. " +
        "Set it in .env.local or fix the Anthropic API error above."
    );
  }
  if (!_openai) _openai = new OpenAI({ apiKey: config.openai.apiKey });
  return _openai;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the ceoOutput field in the master agent's payload. */
interface CeoOutput {
  action: string;
  targetAgent: string;
  parameters: Record<string, unknown>;
  reasoning: string;
}

/** Summary of a single dispatched child job. */
export interface DispatchedJobSummary {
  agentName: string;
  taskId: string;
  companyId?: string;
  companyName?: string;
}

export interface MasterRunResult {
  taskId: string;
  taskType: string;
  executionPlan: string;
  dispatchedJobs: DispatchedJobSummary[];
  totalDispatched: number;
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Normalised task type after mapping from freeform CEO action strings. */
type TaskType =
  | "score_companies"
  | "enrich_contacts"
  | "source_targets"
  | "draft_loi"
  | "outreach_pipe"
  | "unknown";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

/**
 * Normalises the freeform action string the CEO agent returns into one of the
 * known task types. Handles synonyms the LLM might produce.
 */
function normaliseTaskType(action: string): TaskType {
  const a = action.toLowerCase().replace(/[-\s]+/g, "_");

  if (/score|scoring|despac|cfo/.test(a)) return "score_companies";
  if (/enrich|contact|contacts/.test(a))  return "enrich_contacts";
  if (/source|sourcing|target|search/.test(a)) return "source_targets";
  if (/loi|letter_of_intent|draft_loi/.test(a)) return "draft_loi";
  if (/outreach|pipe|pipe_outreach/.test(a))    return "outreach_pipe";

  return "unknown";
}

/**
 * Calls the LLM (Claude primary, OpenAI fallback) with the master system
 * prompt to produce a human-readable execution plan.
 * Returns the plan text and which model was used.
 */
async function callLlmForPlan(
  ceoOutput: CeoOutput | undefined,
  approvedByHuman: boolean
): Promise<{ executionPlan: string; modelUsed: string }> {
  const userMessage = JSON.stringify({
    taskType:        ceoOutput?.action ?? "unknown",
    targetCompanyId: null,
    parameters:      ceoOutput?.parameters ?? {},
    approvedByHuman,
    priority:        "normal",
  });

  try {
    const message = await anthropic.messages.create({
      model:      config.anthropic.model,
      max_tokens: 1024,
      system:     AGENT_PROMPTS.master,
      messages:   [{ role: "user", content: userMessage }],
    });

    if (message.content[0].type !== "text") {
      throw new Error("Claude returned a non-text content block");
    }

    let executionPlan = message.content[0].text;

    // Claude returns JSON — extract the executionPlan field if possible.
    try {
      const parsed = JSON.parse(executionPlan) as Record<string, unknown>;
      executionPlan = String(parsed.executionPlan ?? executionPlan);
    } catch {
      // If it's not JSON just use the raw text as the plan.
    }

    return { executionPlan, modelUsed: config.anthropic.model };
  } catch (claudeErr) {
    console.error("[Master agent] Anthropic API error:", claudeErr);

    if (!config.openai.apiKey) throw claudeErr;

    const claudeMessage =
      claudeErr instanceof Error ? claudeErr.message : String(claudeErr);

    const completion = await getOpenAiClient().chat.completions.create({
      model:           config.openai.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AGENT_PROMPTS.master },
        { role: "user",   content: userMessage },
      ],
    });

    const responseText = completion.choices[0]?.message?.content ?? "{}";
    let executionPlan = responseText;

    try {
      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      executionPlan = String(parsed.executionPlan ?? responseText);
    } catch {
      // use raw text
    }

    return {
      executionPlan,
      modelUsed: `${config.openai.model} (fallback — Claude error: ${claudeMessage})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Task-type fanout functions
// ---------------------------------------------------------------------------

/**
 * score_companies — dispatch a CFO job for every company that has not yet
 * been scored (despac_score IS NULL), up to BATCH_LIMIT per run.
 * If a specific companyId is provided, only that company is scored.
 */
async function dispatchScoreCompanies(
  companyId: string | undefined
): Promise<DispatchedJobSummary[]> {
  const supabase = createAdminClient();
  const results: DispatchedJobSummary[] = [];

  let companies: {
    id: string;
    name: string;
    sector: string | null;
    sub_sector: string | null;
    estimated_valuation: string | null;
    last_round: string | null;
    blurb: string | null;
  }[] = [];

  if (companyId) {
    // Score a single specific company regardless of current score
    const { data, error } = await supabase
      .from("companies")
      .select("id, name, sector, sub_sector, estimated_valuation, last_round, blurb")
      .eq("id", companyId)
      .limit(1);

    if (error) throw new Error(`Failed to fetch company ${companyId}: ${error.message}`);
    companies = data ?? [];
  } else {
    // Score all unscored non-rejected companies, newest first, capped at BATCH_LIMIT
    const { data, error } = await supabase
      .from("companies")
      .select("id, name, sector, sub_sector, estimated_valuation, last_round, blurb")
      .is("despac_score", null)
      .neq("status", "rejected")
      .order("created_at", { ascending: false })
      .limit(BATCH_LIMIT);

    if (error) throw new Error(`Failed to fetch unscored companies: ${error.message}`);
    companies = data ?? [];
  }

  for (const company of companies) {
    try {
      const dispatch: DispatchResult = await dispatchAgentJob(
        "cfo",
        {
          companyId:           company.id,
          name:                company.name,
          sector:              company.sector,
          sub_sector:          company.sub_sector,
          estimated_valuation: company.estimated_valuation,
          last_round:          company.last_round,
          blurb:               company.blurb,
        } as unknown as Parameters<typeof dispatchAgentJob<"cfo">>[1],
        { attempts: 3 }
      );

      results.push({
        agentName:   "cfo",
        taskId:      dispatch.taskId,
        companyId:   company.id,
        companyName: company.name,
      });
    } catch (err) {
      console.error(
        `[Master agent] Failed to dispatch CFO job for "${company.name}":`,
        err
      );
    }
  }

  return results;
}

/**
 * enrich_contacts — dispatch a contact enrichment job for every company
 * that has no contact records at all, up to BATCH_LIMIT per run.
 * If a specific companyId is provided, only that company is enriched.
 */
async function dispatchEnrichContacts(
  companyId: string | undefined
): Promise<DispatchedJobSummary[]> {
  const supabase = createAdminClient();
  const results: DispatchedJobSummary[] = [];

  let companies: { id: string; name: string; website: string | null }[] = [];

  if (companyId) {
    const { data, error } = await supabase
      .from("companies")
      .select("id, name, website")
      .eq("id", companyId)
      .limit(1);

    if (error) throw new Error(`Failed to fetch company ${companyId}: ${error.message}`);
    companies = data ?? [];
  } else {
    // Find all company IDs that already have at least one contact row.
    const { data: existingContacts, error: contactErr } = await supabase
      .from("contacts")
      .select("company_id");

    if (contactErr) {
      throw new Error(`Failed to fetch existing contacts: ${contactErr.message}`);
    }

    const enrichedIds = new Set(
      (existingContacts ?? [])
        .map((c) => c.company_id)
        .filter((id): id is string => typeof id === "string")
    );

    // Fetch non-rejected companies not already in the enriched set.
    const { data: allCompanies, error: companyErr } = await supabase
      .from("companies")
      .select("id, name, website")
      .neq("status", "rejected")
      .order("created_at", { ascending: false })
      .limit(BATCH_LIMIT + enrichedIds.size); // over-fetch so we have enough after filtering

    if (companyErr) {
      throw new Error(`Failed to fetch companies: ${companyErr.message}`);
    }

    companies = (allCompanies ?? [])
      .filter((c) => !enrichedIds.has(c.id))
      .slice(0, BATCH_LIMIT);
  }

  for (const company of companies) {
    try {
      const dispatch: DispatchResult = await dispatchAgentJob(
        "contact",
        {
          companyId:   company.id,
          companyName: company.name,
          website:     company.website,
        } as unknown as Parameters<typeof dispatchAgentJob<"contact">>[1],
        { attempts: 3 }
      );

      results.push({
        agentName:   "contact",
        taskId:      dispatch.taskId,
        companyId:   company.id,
        companyName: company.name,
      });
    } catch (err) {
      console.error(
        `[Master agent] Failed to dispatch contact job for "${company.name}":`,
        err
      );
    }
  }

  return results;
}

/**
 * source_targets — dispatch one sourcing job.
 * Passes sector and searchCriteria from the CEO parameters if available.
 */
async function dispatchSourceTargets(
  parameters: Record<string, unknown> | undefined
): Promise<DispatchedJobSummary[]> {
  const sector = typeof parameters?.sector === "string" ? parameters.sector : undefined;

  const dispatch: DispatchResult = await dispatchAgentJob(
    "sourcing",
    {
      sector:         sector as Parameters<typeof dispatchAgentJob<"sourcing">>[1] extends { sector?: infer S } ? S : undefined,
      searchCriteria: (parameters?.searchCriteria ?? {}) as Record<string, unknown>,
    } as unknown as Parameters<typeof dispatchAgentJob<"sourcing">>[1],
    { attempts: 2 }
  );

  return [{ agentName: "sourcing", taskId: dispatch.taskId }];
}

/**
 * draft_loi — dispatch an LOI job for a specific company.
 * Requires approvedByHuman: true and a companyId.
 */
async function dispatchDraftLoi(
  companyId: string | undefined,
  parameters: Record<string, unknown> | undefined,
  approvedByHuman: boolean
): Promise<DispatchedJobSummary[]> {
  if (!approvedByHuman) {
    throw new Error("draft_loi requires approvedByHuman: true");
  }
  if (!companyId) {
    throw new Error("draft_loi requires a specific companyId");
  }

  const supabase = createAdminClient();
  const { data: company, error } = await supabase
    .from("companies")
    .select("id, name, sector, estimated_valuation, blurb, despac_score")
    .eq("id", companyId)
    .single();

  if (error || !company) {
    throw new Error(`Company ${companyId} not found for LOI dispatch`);
  }

  const dispatch: DispatchResult = await dispatchAgentJob(
    "loi",
    {
      companyId,
      approvedByHuman: true as const,
      company: {
        name:                company.name,
        sector:              company.sector,
        estimated_valuation: company.estimated_valuation,
        blurb:               company.blurb,
        despac_score:        company.despac_score,
      },
      terms: (parameters?.terms ?? {}) as Record<string, unknown>,
    } as unknown as Parameters<typeof dispatchAgentJob<"loi">>[1],
    { attempts: 2 }
  );

  return [{
    agentName:   "loi",
    taskId:      dispatch.taskId,
    companyId,
    companyName: company.name,
  }];
}

/**
 * outreach_pipe — dispatch outreach and pipe jobs for a specific company.
 * Requires approvedByHuman: true and a companyId.
 */
async function dispatchOutreachPipe(
  companyId: string | undefined,
  parameters: Record<string, unknown> | undefined,
  approvedByHuman: boolean
): Promise<DispatchedJobSummary[]> {
  if (!approvedByHuman) {
    throw new Error("outreach_pipe requires approvedByHuman: true");
  }
  if (!companyId) {
    throw new Error("outreach_pipe requires a specific companyId");
  }

  const supabase = createAdminClient();

  // Fetch company and its primary contact in parallel
  const [companyRes, contactRes] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, sector, estimated_valuation, blurb, despac_score")
      .eq("id", companyId)
      .single(),
    supabase
      .from("contacts")
      .select("name, title, email")
      .eq("company_id", companyId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  if (companyRes.error || !companyRes.data) {
    throw new Error(`Company ${companyId} not found for outreach dispatch`);
  }

  const company = companyRes.data;
  const contact = contactRes.data ?? {};

  const companyObject = {
    name:                company.name,
    sector:              company.sector,
    estimated_valuation: company.estimated_valuation,
    blurb:               company.blurb,
    despac_score:        company.despac_score,
  };

  const results: DispatchedJobSummary[] = [];

  // Dispatch outreach
  const outreachDispatch: DispatchResult = await dispatchAgentJob(
    "outreach",
    {
      companyId,
      approvedByHuman,
      contact:         contact as Record<string, unknown>,
      company:         companyObject,
      outreachContext: parameters?.outreachContext ?? {},
    } as unknown as Parameters<typeof dispatchAgentJob<"outreach">>[1],
    { attempts: 2 }
  );

  results.push({
    agentName:   "outreach",
    taskId:      outreachDispatch.taskId,
    companyId,
    companyName: company.name,
  });

  // Dispatch pipe
  const pipeDispatch: DispatchResult = await dispatchAgentJob(
    "pipe",
    {
      companyId,
      approvedByHuman,
      dealTerms: (parameters?.dealTerms ?? {}) as Record<string, unknown>,
    } as unknown as Parameters<typeof dispatchAgentJob<"pipe">>[1],
    { attempts: 2 }
  );

  results.push({
    agentName:   "pipe",
    taskId:      pipeDispatch.taskId,
    companyId,
    companyName: company.name,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Master agent.
 *
 * Flow:
 *   1. Mark the agent_tasks row as running.
 *   2. Call Claude to produce an execution plan (for logging and transparency).
 *   3. Normalise the CEO action string to a known task type.
 *   4. Run the deterministic fanout for that task type.
 *   5. Mark agent_tasks completed (or failed on any error).
 *   6. Return MasterRunResult with all dispatched task IDs.
 *
 * @param input - AgentInput from the BullMQ worker or API route
 * @returns     MasterRunResult with task summaries
 * @throws      On task-type errors or Supabase failures, after marking the task failed
 */
export async function runMasterAgent(input: AgentInput): Promise<MasterRunResult> {
  const supabase = createAdminClient();
  const payload    = input.payload ?? {};
  const ceoOutput  = payload.ceoOutput as CeoOutput | undefined;
  const companyId  =
    input.companyId ??
    (typeof payload.companyId === "string" ? payload.companyId : undefined);
  const approvedByHuman = input.approvedByHuman ?? false;

  // ------------------------------------------------------------------
  // 1. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: now() })
    .eq("id", input.taskId);

  try {
    // ------------------------------------------------------------------
    // 2. Call LLM for execution plan (transparency — not used for routing)
    // ------------------------------------------------------------------
    const { executionPlan, modelUsed } = await callLlmForPlan(
      ceoOutput,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 3. Normalise task type
    // ------------------------------------------------------------------
    const taskType = normaliseTaskType(ceoOutput?.action ?? "");

    // ------------------------------------------------------------------
    // 4. Deterministic fanout per task type
    // ------------------------------------------------------------------
    let dispatched: DispatchedJobSummary[] = [];

    switch (taskType) {
      case "score_companies":
        dispatched = await dispatchScoreCompanies(companyId);
        break;

      case "enrich_contacts":
        dispatched = await dispatchEnrichContacts(companyId);
        break;

      case "source_targets":
        dispatched = await dispatchSourceTargets(ceoOutput?.parameters);
        break;

      case "draft_loi":
        dispatched = await dispatchDraftLoi(
          companyId,
          ceoOutput?.parameters,
          approvedByHuman
        );
        break;

      case "outreach_pipe":
        dispatched = await dispatchOutreachPipe(
          companyId,
          ceoOutput?.parameters,
          approvedByHuman
        );
        break;

      default:
        // Unrecognised action — log it so the monitor surfaces it, but don't
        // crash: the co-founder will see 0 dispatched jobs and can rephrase.
        console.warn(
          `[Master agent] Unrecognised action "${ceoOutput?.action}" — no jobs dispatched`
        );
    }

    // ------------------------------------------------------------------
    // 5. Mark task completed
    // ------------------------------------------------------------------
    const result: MasterRunResult = {
      taskId:          input.taskId,
      taskType,
      executionPlan,
      dispatchedJobs:  dispatched,
      totalDispatched: dispatched.length,
      approvedByHuman,
      modelUsed,
    };

    await supabase
      .from("agent_tasks")
      .update({
        status:       "completed",
        output:       result as unknown as Record<string, unknown>,
        completed_at: now(),
      })
      .eq("id", input.taskId);

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    await supabase
      .from("agent_tasks")
      .update({ status: "failed", error, completed_at: now() })
      .eq("id", input.taskId);

    throw err;
  }
}
