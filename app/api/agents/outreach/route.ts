/**
 * POST /api/agents/outreach
 *
 * Triggers the Outreach agent to draft a personalised 3-email sequence
 * (initial + two follow-ups) for an approved deSPAC acquisition target.
 * Requires approvedByHuman: true — the agent will reject the request otherwise.
 *
 * Request body:
 *   {
 *     companyId:       string (uuid)   — target company
 *     approvedByHuman: boolean         — must be true to proceed
 *     outreachContext?: {
 *       senderName?:      string       — co-founder name to appear as sender
 *       angle?:           string       — e.g. "acquisition interest"
 *       personalisation?: string       — notes to personalise the emails
 *     }
 *   }
 *
 * Response (202):
 *   OutreachRunResult — taskId, companyId, companyName, emails[], outreachSummary,
 *                       contactsTargeted, reviewRequired, approvedByHuman, modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runOutreachAgent } from "@/lib/agents/sub-agents/outreach-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId:       z.string().uuid(),
  approvedByHuman: z.boolean(),
  outreachContext: z
    .object({
      senderName:      z.string().optional(),
      angle:           z.string().optional(),
      personalisation: z.string().optional(),
    })
    .optional(),
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

  const { companyId, approvedByHuman, outreachContext } = parsed.data;

  const supabase = createAdminClient();

  // Verify the company exists and is in an actionable state
  const { data: company, error: fetchError } = await supabase
    .from("companies")
    .select("id, name, status")
    .eq("id", companyId)
    .single();

  if (fetchError || !company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  // Only allow outreach for companies that have been approved or already have an LOI
  const allowedStatuses = ["approved", "loi_sent"];
  if (!allowedStatuses.includes(company.status)) {
    return NextResponse.json(
      {
        error: `Company status is "${company.status}". Outreach can only be drafted for companies with status "approved" or "loi_sent".`,
      },
      { status: 422 }
    );
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    approvedByHuman,
    ...(outreachContext ? { outreachContext } : {}),
  };

  // Create agent_tasks row so the monitor shows it immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "outreach", status: "queued", input: taskInput })
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
    const result = await runOutreachAgent({
      agentName:       "outreach",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/outreach] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Outreach agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
