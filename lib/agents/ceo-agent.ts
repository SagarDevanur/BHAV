/**
 * CEO Agent — the sole entry point from co-founders into the agent system.
 *
 * Input:  { prompt: string; founderId: string; approvedByHuman?: boolean }
 * Output: { ceoTaskId, summary, taskType, dispatchedJobs[] }
 *
 * Runs inline (not via BullMQ) so the dashboard gets an immediate structured
 * response showing exactly what was dispatched and why.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "./prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchAgentJob } from "@/lib/queue/dispatcher";
import type { DispatchResult } from "@/lib/queue/dispatcher";
import type { JobInput } from "@/lib/queue/jobs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CeoInput {
  /**
   * Plain English instruction from a co-founder.
   * Optional when called from the BullMQ worker (prompt arrives via AgentInput.prompt).
   */
  prompt?: string;
  /**
   * Clerk userId of the co-founder issuing the instruction.
   * Optional when called from the BullMQ worker (where the payload is an AgentInput).
   */
  founderId?: string;
  /** Must be explicitly set to true before any external-action agents are dispatched. */
  approvedByHuman?: boolean;
}

/** Shape of the JSON directive that Claude returns for the CEO prompt. */
interface CeoDirective {
  summary: string;
  routeTo: "master";
  taskType: string;
  targetCompanyId: string | null;
  parameters: Record<string, unknown>;
  approvedByHuman: boolean;
  priority: "low" | "normal" | "high";
  clarificationNeeded?: boolean;
}

export interface DispatchedJob {
  agentName: string;
  taskId: string;
  bullJobId: string;
}

export interface CeoRunResult {
  /** UUID of the CEO agent_tasks row — poll this for CEO-level status. */
  ceoTaskId: string;
  /** One-sentence summary of what the CEO agent understood. */
  summary: string;
  /** The task type routed to the master agent (e.g. "source", "score", "draft_loi"). */
  taskType: string;
  /** Whether the co-founder approved external actions for this request. */
  approvedByHuman: boolean;
  /** Every BullMQ job dispatched as a result of this CEO run. */
  dispatchedJobs: DispatchedJob[];
  /** Which model was ultimately used (Claude or OpenAI fallback). */
  modelUsed: string;
}

// ---------------------------------------------------------------------------
// LLM clients
// ---------------------------------------------------------------------------

// Anthropic is always initialised — it is the required primary LLM.
const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// OpenAI is lazy-initialised only when needed for fallback.
// It will be undefined when OPENAI_API_KEY is not set.
let _openai: OpenAI | null = null;
function getOpenAiClient(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error(
      "OpenAI fallback is unavailable: OPENAI_API_KEY is not set. " +
        "Set it in .env.local or fix the Anthropic API error above."
    );
  }
  if (!_openai) {
    _openai = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return _openai;
}

// ---------------------------------------------------------------------------
// BullMQ priority mapping (lower number = higher priority in BullMQ)
// ---------------------------------------------------------------------------

const PRIORITY_MAP: Record<CeoDirective["priority"], number> = {
  high:   1,
  normal: 5,
  low:    10,
};

// ---------------------------------------------------------------------------
// Core CEO agent function
// ---------------------------------------------------------------------------

/**
 * Runs the CEO agent with a co-founder prompt.
 *
 * 1. Creates an agent_tasks row immediately (status = "running").
 * 2. Calls Claude with the CEO system prompt; falls back to OpenAI on failure.
 * 3. Parses Claude's JSON routing directive.
 * 4. Dispatches a master agent job via BullMQ with the structured directive.
 * 5. Marks the agent_tasks row as completed (or failed on error).
 * 6. Returns a structured result with all dispatched task IDs.
 */
export async function runCeoAgent(input: CeoInput): Promise<CeoRunResult> {
  const prompt = input.prompt?.trim();
  if (!prompt) {
    throw new Error("CEO agent requires a non-empty prompt");
  }

  const supabase = createAdminClient();

  // ------------------------------------------------------------------
  // 1. Log CEO task — mark running immediately so the monitor reflects it
  // ------------------------------------------------------------------
  const { data: taskRow, error: insertError } = await supabase
    .from("agent_tasks")
    .insert({
      agent_name: "ceo",
      status: "running",
      started_at: new Date().toISOString(),
      input: {
        prompt,
        founderId: input.founderId ?? "unknown",
        approvedByHuman: input.approvedByHuman ?? false,
      },
    })
    .select("id")
    .single();

  if (insertError || !taskRow) {
    throw new Error(
      `CEO agent failed to create agent_tasks row: ${insertError?.message ?? "no row returned"}`
    );
  }

  const ceoTaskId = taskRow.id as string;

  try {
    // ------------------------------------------------------------------
    // 2. Call LLM — Claude primary, OpenAI fallback
    // ------------------------------------------------------------------
    const userMessage = JSON.stringify({
      instruction: prompt,
      context: null,
      requestedBy: input.founderId ?? "unknown",
      approvedByHuman: input.approvedByHuman ?? false,
    });

    let responseText: string;
    let modelUsed: string;

    try {
      const message = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 1024,
        system: AGENT_PROMPTS.ceo,
        messages: [{ role: "user", content: userMessage }],
      });

      if (message.content[0].type !== "text") {
        throw new Error("Claude returned a non-text content block");
      }

      responseText = message.content[0].text;
      modelUsed = config.anthropic.model;
    } catch (claudeErr) {
      // Log the full Anthropic error so it appears in server logs / Vercel logs.
      console.error("[CEO agent] Anthropic API error:", claudeErr);

      // Rethrow immediately if OpenAI fallback is unavailable — no point
      // catching the error only to throw a worse one inside getOpenAiClient().
      if (!config.openai.apiKey) {
        throw claudeErr;
      }

      const claudeMessage =
        claudeErr instanceof Error ? claudeErr.message : String(claudeErr);

      const completion = await getOpenAiClient().chat.completions.create({
        model: config.openai.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: AGENT_PROMPTS.ceo },
          { role: "user", content: userMessage },
        ],
      });

      responseText = completion.choices[0]?.message?.content ?? "{}";
      modelUsed = `${config.openai.model} (fallback — Claude error: ${claudeMessage})`;
    }

    // ------------------------------------------------------------------
    // 3. Parse directive — strip markdown code fences before parsing
    // ------------------------------------------------------------------
    let directive: CeoDirective;
    try {
      const cleanJson = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      directive = JSON.parse(cleanJson) as CeoDirective;
    } catch {
      throw new Error(
        `CEO agent received non-JSON from ${modelUsed}: ${responseText.slice(0, 300)}`
      );
    }

    // Ensure approvedByHuman is never silently upgraded
    const approvedByHuman = (input.approvedByHuman ?? false) && directive.approvedByHuman;

    // ------------------------------------------------------------------
    // 4. Dispatch master agent job via BullMQ
    // ------------------------------------------------------------------
    const dispatched: DispatchResult[] = [];

    // JobInput<T> has a phantom _agent brand — cast through unknown to satisfy it
    // while letting Zod validate the actual shape at runtime inside the dispatcher.
    const masterPayload = {
      ceoOutput: {
        action:      directive.taskType,
        targetAgent: "master",
        parameters:  directive.parameters ?? {},
        reasoning:   directive.summary,
      },
      companyId: directive.targetCompanyId ?? undefined,
    } as unknown as JobInput<"master">;

    const masterDispatch = await dispatchAgentJob(
      "master",
      masterPayload,
      { priority: PRIORITY_MAP[directive.priority ?? "normal"] }
    );

    dispatched.push(masterDispatch);

    // ------------------------------------------------------------------
    // 5. Mark CEO task completed
    // ------------------------------------------------------------------
    const output = {
      summary:          directive.summary,
      taskType:         directive.taskType,
      targetCompanyId:  directive.targetCompanyId,
      approvedByHuman,
      priority:         directive.priority,
      masterTaskId:     masterDispatch.taskId,
      modelUsed,
      ...(directive.clarificationNeeded ? { clarificationNeeded: true } : {}),
    };

    await supabase
      .from("agent_tasks")
      .update({
        status:       "completed",
        output,
        completed_at: new Date().toISOString(),
      })
      .eq("id", ceoTaskId);

    // ------------------------------------------------------------------
    // 6. Return structured result
    // ------------------------------------------------------------------
    return {
      ceoTaskId,
      summary:        directive.summary,
      taskType:       directive.taskType,
      approvedByHuman,
      modelUsed,
      dispatchedJobs: dispatched.map((d) => ({
        agentName: "master",
        taskId:    d.taskId,
        bullJobId: d.bullJobId,
      })),
    };
  } catch (err) {
    // Mark failed — never leave a task stuck at "running"
    const error = err instanceof Error ? err.message : String(err);

    await supabase
      .from("agent_tasks")
      .update({
        status:       "failed",
        error,
        completed_at: new Date().toISOString(),
      })
      .eq("id", ceoTaskId);

    throw err;
  }
}
