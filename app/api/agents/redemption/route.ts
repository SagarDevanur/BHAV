/**
 * POST /api/agents/redemption
 *
 * Triggers the Redemption agent to model SPAC shareholder redemption risk for a
 * target company. This is a pure analysis endpoint — no external actions are taken
 * and no approvedByHuman gate is enforced.
 *
 * Request body:
 *   {
 *     companyId:         string (uuid)  — target company
 *     approvedByHuman?:  boolean        — passed through to LLM; does not gate execution
 *     spac_trust_size?:  string         — default "$150M"
 *     pipeSize?:         string         — e.g. "$30M"
 *     dealPremium?:      string         — e.g. "15%" premium over NAV
 *     marketConditions?: string         — free-text description of current market context
 *   }
 *
 * Response (202):
 *   RedemptionRunResult — taskId, companyId, companyName, redemptionForecast,
 *                         riskFactors, minimumViableCash, dealViabilityAssessment,
 *                         mitigationStrategies, comparableDeals, analysisSummary,
 *                         approvedByHuman, modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRedemptionAgent } from "@/lib/agents/sub-agents/redemption-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId:         z.string().uuid(),
  approvedByHuman:   z.boolean().optional(),
  spac_trust_size:   z.string().optional(),
  pipeSize:          z.string().optional(),
  dealPremium:       z.string().optional(),
  marketConditions:  z.string().optional(),
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

  const {
    companyId,
    approvedByHuman,
    spac_trust_size,
    pipeSize,
    dealPremium,
    marketConditions,
  } = parsed.data;

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

  // Redemption analysis can be run from any non-rejected status —
  // it is useful at the scoring stage, not just after approval
  if (company.status === "rejected") {
    return NextResponse.json(
      { error: `Company has been rejected and cannot be analysed.` },
      { status: 422 }
    );
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    approvedByHuman: approvedByHuman ?? false,
    ...(spac_trust_size  ? { spac_trust_size }  : {}),
    ...(pipeSize         ? { pipeSize }          : {}),
    ...(dealPremium      ? { dealPremium }        : {}),
    ...(marketConditions ? { marketConditions }   : {}),
  };

  // Create agent_tasks row so the monitor reflects the job immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "redemption", status: "queued", input: taskInput })
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
    const result = await runRedemptionAgent({
      agentName:       "redemption",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman: approvedByHuman ?? false,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/redemption] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Redemption agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
