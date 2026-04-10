/**
 * POST /api/agents/optimization
 *
 * Triggers the Optimization agent to synthesise all prior agent outputs (CFO score,
 * structuring, PIPE, and redemption) into a final deal optimisation report.
 *
 * This is a pure analysis endpoint — no external actions are taken and no
 * approvedByHuman gate is enforced. Prior agent results that have not yet been
 * run are passed as null; the LLM is told which are absent and calibrates
 * accordingly with conservative assumptions.
 *
 * Request body:
 *   {
 *     companyId:        string (uuid)  — target company
 *     approvedByHuman?: boolean        — passed through to LLM; does not gate execution
 *   }
 *
 * Response (202):
 *   OptimizationRunResult — taskId, companyId, companyName,
 *                           valuationAdjustment, structureTweaks,
 *                           timingRecommendation, riskMitigationActions,
 *                           closeProbabilityDelta, goNoGo, summary,
 *                           priorResultsUsed, approvedByHuman, modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runOptimizationAgent } from "@/lib/agents/sub-agents/optimization-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId:       z.string().uuid(),
  approvedByHuman: z.boolean().optional(),
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

  const { companyId, approvedByHuman } = parsed.data;

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

  // Optimisation is meaningful once scoring has run — block only on rejected
  if (company.status === "rejected") {
    return NextResponse.json(
      { error: "Company has been rejected and cannot be optimised." },
      { status: 422 }
    );
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    approvedByHuman: approvedByHuman ?? false,
  };

  // Create agent_tasks row so the monitor reflects the job immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "optimization", status: "queued", input: taskInput })
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
    const result = await runOptimizationAgent({
      agentName:       "optimization",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman: approvedByHuman ?? false,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/optimization] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Optimization agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
