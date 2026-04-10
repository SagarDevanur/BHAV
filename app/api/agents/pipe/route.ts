/**
 * POST /api/agents/pipe
 *
 * Triggers the PIPE agent to produce a full investor targeting analysis and deal
 * teaser for an approved deSPAC target. Requires approvedByHuman: true — the
 * agent will reject the request otherwise and log the failure to agent_tasks.
 *
 * No investor is ever contacted by this agent. The investor list and teaser must
 * be reviewed and approved by a co-founder before any distribution occurs.
 *
 * Request body:
 *   {
 *     companyId:          string (uuid)  — target company
 *     approvedByHuman:    boolean        — must be true to proceed
 *     pipeSize?:          string         — e.g. "$30M" (defaults to [PLACEHOLDER])
 *     proFormaValuation?: string         — e.g. "$180M" (defaults to company estimate)
 *     spac_trust_size?:   string         — default "$150M"
 *   }
 *
 * Response (202):
 *   PipeRunResult — taskId, companyId, companyName, targetInvestors (10 ranked),
 *                   pipeRecommendation, investorTeaser, outreachStrategy,
 *                   pipeRoadmapSummary, reviewRequired, approvedByHuman, modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runPipeAgent } from "@/lib/agents/sub-agents/pipe-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId:          z.string().uuid(),
  approvedByHuman:    z.boolean(),
  pipeSize:           z.string().optional(),
  proFormaValuation:  z.string().optional(),
  spac_trust_size:    z.string().optional(),
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

  const { companyId, approvedByHuman, pipeSize, proFormaValuation, spac_trust_size } =
    parsed.data;

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

  // PIPE analysis is only valid for companies that have been approved or further progressed
  const allowedStatuses = ["approved", "loi_sent"];
  if (!allowedStatuses.includes(company.status)) {
    return NextResponse.json(
      {
        error: `Company status is "${company.status}". PIPE analysis is only available for companies with status "approved" or "loi_sent".`,
      },
      { status: 422 }
    );
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    approvedByHuman,
    ...(pipeSize          ? { pipeSize }          : {}),
    ...(proFormaValuation ? { proFormaValuation }  : {}),
    ...(spac_trust_size   ? { spac_trust_size }    : {}),
  };

  // Create agent_tasks row so the monitor reflects the job immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "pipe", status: "queued", input: taskInput })
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
    const result = await runPipeAgent({
      agentName:       "pipe",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/pipe] unhandled error:", err);
    const message = err instanceof Error ? err.message : "PIPE agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
