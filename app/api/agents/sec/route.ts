/**
 * POST /api/agents/sec
 *
 * Triggers the SEC agent to draft a full S-4 registration statement for an
 * approved deSPAC target. Requires approvedByHuman: true — the agent will
 * reject the request otherwise and log the failure to agent_tasks.
 *
 * Request body:
 *   {
 *     companyId:       string (uuid)   — target company
 *     approvedByHuman: boolean         — must be true to produce a draft
 *     dealParameters?: {
 *       proposedValuation?: string     — e.g. "$120M–$150M"
 *       structure?:         string     — default "deSPAC merger"
 *       spac_name?:         string     — default "BHAV Acquisition Corp"
 *       spac_trust_size?:   string     — default "$150M"
 *     }
 *   }
 *
 * Response (202):
 *   SecRunResult — taskId, companyId, companyName, s4_draft, missingDataFlags,
 *                  wordCount, legalReviewRequired, approvedByHuman, modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runSecAgent } from "@/lib/agents/sub-agents/sec-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId:       z.string().uuid(),
  approvedByHuman: z.boolean(),
  dealParameters: z
    .object({
      proposedValuation: z.string().optional(),
      structure:         z.string().optional(),
      spac_name:         z.string().optional(),
      spac_trust_size:   z.string().optional(),
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

  const { companyId, approvedByHuman, dealParameters } = parsed.data;

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

  // SEC drafting is only valid for companies that have been approved or further progressed
  const allowedStatuses = ["approved", "loi_sent"];
  if (!allowedStatuses.includes(company.status)) {
    return NextResponse.json(
      {
        error: `Company status is "${company.status}". SEC drafting is only available for companies with status "approved" or "loi_sent".`,
      },
      { status: 422 }
    );
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    approvedByHuman,
    ...(dealParameters ? { dealParameters } : {}),
  };

  // Create agent_tasks row so the monitor reflects the job immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "sec", status: "queued", input: taskInput })
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
    const result = await runSecAgent({
      agentName:       "sec",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/sec] unhandled error:", err);
    const message = err instanceof Error ? err.message : "SEC agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
