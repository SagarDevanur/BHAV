/**
 * POST /api/agents/narrative
 *
 * Triggers the Narrative agent to produce three deal documents for an approved
 * deSPAC target: an investor story, a press release draft, and a PIPE executive
 * summary. Requires approvedByHuman: true — the agent will reject the request
 * otherwise and log the failure to agent_tasks.
 *
 * Request body:
 *   {
 *     companyId:       string (uuid)                             — target company
 *     approvedByHuman: boolean                                   — must be true
 *     audienceType?:   "internal" | "investor" | "board"        — default "investor"
 *   }
 *
 * Response (202):
 *   NarrativeRunResult — taskId, companyId, companyName, narrativeTitle,
 *                        investor_story, press_release, executive_summary,
 *                        synopsis, keyRisks, reviewRequired, approvedByHuman,
 *                        modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runNarrativeAgent } from "@/lib/agents/sub-agents/narrative-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId:       z.string().uuid(),
  approvedByHuman: z.boolean(),
  audienceType:    z.enum(["internal", "investor", "board"]).optional(),
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
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const { companyId, approvedByHuman, audienceType } = parsed.data;

  const supabase = createAdminClient();

  // Verify the company exists
  const { data: company, error: fetchError } = await supabase
    .from("companies")
    .select("id, name, status")
    .eq("id", companyId)
    .single();

  if (fetchError || !company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  // Narrative documents are only valid for companies that have been approved or further
  const allowedStatuses = ["approved", "loi_sent"];
  if (!allowedStatuses.includes(company.status)) {
    return NextResponse.json(
      {
        error: `Company status is "${company.status}". Narrative documents can only be drafted for companies with status "approved" or "loi_sent".`,
      },
      { status: 422 }
    );
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    approvedByHuman,
    ...(audienceType ? { audienceType } : {}),
  };

  // Create agent_tasks row so the monitor reflects the job immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "narrative", status: "queued", input: taskInput })
    .select("id")
    .single();

  if (taskInsertError || !taskRow) {
    return NextResponse.json(
      {
        error: `Failed to create agent_tasks row: ${
          taskInsertError?.message ?? "no row returned"
        }`,
      },
      { status: 500 }
    );
  }

  try {
    const result = await runNarrativeAgent({
      agentName:       "narrative",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/narrative] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Narrative agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
