/**
 * POST /api/agents/loi
 *
 * Triggers the LOI agent to draft a Letter of Intent for an approved target.
 * Requires approvedByHuman: true — the agent will reject the request otherwise.
 *
 * Request body:
 *   {
 *     companyId:       string (uuid)   — target company
 *     approvedByHuman: boolean         — must be true to proceed
 *     terms?:          object          — optional deal term overrides
 *       proposedValuation?:     string
 *       structure?:             string
 *       exclusivityPeriodDays?: number
 *       keyTerms?:              string[]
 *   }
 *
 * Response (202):
 *   LoiRunResult — taskId, companyId, companyName, loi_draft, summary,
 *                  reviewRequired, warnings, statusAdvanced, approvedByHuman,
 *                  modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runLoiAgent } from "@/lib/agents/sub-agents/loi-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId:       z.string().uuid(),
  approvedByHuman: z.boolean(),
  terms: z
    .object({
      proposedValuation:     z.string().optional(),
      structure:             z.string().optional(),
      exclusivityPeriodDays: z.number().int().positive().optional(),
      keyTerms:              z.array(z.string()).optional(),
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

  const { companyId, approvedByHuman, terms } = parsed.data;

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

  // Only allow LOI drafting for approved companies (or already loi_sent for re-draft)
  const allowedStatuses = ["approved", "loi_sent"];
  if (!allowedStatuses.includes(company.status)) {
    return NextResponse.json(
      {
        error: `Company status is "${company.status}". LOI can only be drafted for companies with status "approved".`,
      },
      { status: 422 }
    );
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    approvedByHuman,
    ...(terms ? { terms } : {}),
  };

  // Create agent_tasks row so the monitor shows it immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "loi", status: "queued", input: taskInput })
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
    const result = await runLoiAgent({
      agentName:       "loi",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/loi] unhandled error:", err);
    const message = err instanceof Error ? err.message : "LOI agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
