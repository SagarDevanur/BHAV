// Dispatcher — the single entry point for creating and enqueuing agent jobs.
// Every agent job MUST go through dispatchAgentJob. Never call agentQueue.add() directly.
//
// Responsibilities:
//   1. Validate the job payload against the per-agent Zod schema
//   2. Insert a row into agent_tasks (status = "queued") and get its UUID
//   3. Add the job to BullMQ with that UUID as taskId
//   4. Return the taskId so callers can poll for status
import "server-only";
import { agentQueue, AGENT_QUEUE_NAME } from "./queue";
import { JOB_NAMES, jobInputSchemas, MAX_RETRIES } from "./jobs";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentName, AgentInput, AgentDispatchOptions } from "@/types/agents";
import type { JobInput } from "./jobs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchResult {
  /** UUID of the newly created agent_tasks row. Poll this to track progress. */
  taskId: string;
  /** BullMQ job ID (different from taskId — internal to BullMQ). */
  bullJobId: string;
  /** Queue name the job was added to. */
  queue: typeof AGENT_QUEUE_NAME;
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

/**
 * Validates, logs, and enqueues an agent job.
 *
 * @param agentName    - Which agent will handle the job
 * @param payload      - Agent-specific input (validated against jobInputSchemas)
 * @param options      - Optional BullMQ overrides (priority, delay, attempts)
 * @returns            - DispatchResult containing the taskId and BullMQ job ID
 *
 * @throws             - If Zod validation fails or either the DB insert or
 *                       queue.add() call fails
 */
export async function dispatchAgentJob<T extends AgentName>(
  agentName: T,
  payload: JobInput<T>,
  options: AgentDispatchOptions = {}
): Promise<DispatchResult> {
  // 1. Validate the payload against the agent's Zod schema
  const schema = jobInputSchemas[agentName];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Invalid payload for agent "${agentName}": ${parsed.error.message}`
    );
  }

  const supabase = createAdminClient();

  // 2. Insert agent_tasks row — this gives us the DB-generated taskId UUID.
  //    The row is written BEFORE the job hits the queue so the worker always
  //    finds an existing row to update.
  const { data: taskRow, error: insertError } = await supabase
    .from("agent_tasks")
    .insert({
      agent_name: agentName,
      status: "queued",
      input: parsed.data as Record<string, unknown>,
    })
    .select("id")
    .single();

  if (insertError || !taskRow) {
    throw new Error(
      `Failed to create agent_tasks row for "${agentName}": ${insertError?.message ?? "no row returned"}`
    );
  }

  const taskId = taskRow.id;

  // 3. Build the full AgentInput that the worker receives
  const jobInput: AgentInput = {
    agentName,
    taskId,
    // Hoist companyId to the top level if the payload contains it
    companyId: (parsed.data as Record<string, unknown>).companyId as
      | string
      | undefined,
    approvedByHuman:
      (parsed.data as Record<string, unknown>).approvedByHuman as
        | boolean
        | undefined,
    // CEO is the only agent that carries a raw prompt
    prompt:
      agentName === "ceo"
        ? (parsed.data as Record<string, unknown>).prompt as string
        : undefined,
    payload: parsed.data as Record<string, unknown>,
  };

  // 4. Add to BullMQ — if this fails, mark the task as failed in DB so the
  //    agent monitor shows an accurate state rather than stuck at "queued".
  let bullJobId: string;
  try {
    const job = await agentQueue.add(JOB_NAMES[agentName], jobInput, {
      priority: options.priority,
      delay: options.delay,
      attempts: options.attempts ?? MAX_RETRIES,
      jobId: taskId, // Use the DB taskId as the BullMQ jobId for easy correlation
    });
    bullJobId = job.id ?? taskId;
  } catch (err) {
    // Roll back the task status so the monitor doesn't show a ghost "queued" job
    await supabase
      .from("agent_tasks")
      .update({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completed_at: new Date().toISOString(),
      })
      .eq("id", taskId);

    throw new Error(
      `Failed to enqueue job for "${agentName}" (taskId: ${taskId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return { taskId, bullJobId, queue: AGENT_QUEUE_NAME };
}
