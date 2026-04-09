/**
 * POST /api/agents/master
 *
 * Triggers the Master agent directly — useful for manual orchestration from
 * the dashboard without going through the CEO agent / BullMQ queue.
 *
 * The CEO agent dispatches master jobs via BullMQ; this route lets co-founders
 * (or the dashboard) trigger specific task types synchronously and see the
 * full list of child jobs that were dispatched.
 *
 * Request body:
 *   {
 *     action:          string,          // e.g. "score_companies", "enrich_contacts"
 *     companyId?:      string (uuid),   // target company for single-company actions
 *     parameters?:     object,          // extra params forwarded to sub-agents
 *     approvedByHuman?: boolean         // required true for loi / outreach_pipe
 *   }
 *
 * Response (202):
 *   MasterRunResult — taskId, taskType, executionPlan, dispatchedJobs[], totalDispatched
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runMasterAgent } from "@/lib/agents/master-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  /** Task type string — matched flexibly in the master agent (synonyms accepted). */
  action: z.string().min(1),
  /** UUID of a specific company to scope the action to. Optional for bulk operations. */
  companyId: z.string().uuid().optional(),
  /** Freeform parameters forwarded to sub-agents (sector, terms, etc.). */
  parameters: z.record(z.string(), z.unknown()).optional(),
  /** Must be true for draft_loi and outreach_pipe actions. */
  approvedByHuman: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 422 }
    );
  }

  const { action, companyId, parameters, approvedByHuman } = parsed.data;
  const supabase = createAdminClient();

  // ------------------------------------------------------------------
  // Build the ceoOutput shape the master agent expects — this mirrors
  // what the CEO agent produces when routing to master via BullMQ.
  // ------------------------------------------------------------------
  const ceoOutput = {
    action,
    targetAgent: "master",
    parameters:  parameters ?? {},
    reasoning:   `Direct API trigger: action=${action}`,
  };

  const taskInput: Record<string, unknown> = {
    ceoOutput,
    companyId: companyId ?? null,
    approvedByHuman,
  };

  // ------------------------------------------------------------------
  // Create agent_tasks row so the monitor shows it immediately.
  // ------------------------------------------------------------------
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({
      agent_name: "master",
      status:     "queued",
      input:      taskInput,
    })
    .select("id")
    .single();

  if (taskInsertError || !taskRow) {
    return NextResponse.json(
      {
        error: `Failed to create agent_tasks row: ${taskInsertError?.message ?? "no row returned"}`,
      },
      { status: 500 }
    );
  }

  // ------------------------------------------------------------------
  // Run master agent inline and return the full dispatch summary.
  // ------------------------------------------------------------------
  try {
    const result = await runMasterAgent({
      agentName:       "master",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/master] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Master agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
