/**
 * POST /api/agents/scoring
 *
 * Triggers the Scoring agent to evaluate and score companies for deSPAC fit.
 * Accepts a list of company IDs, a sector filter, or neither (scores all
 * unscored companies). Processes in batches of 10 with progress updates.
 *
 * Note: maxDuration is set to 300s in vercel.json. For very large batches
 * (> ~30 companies), prefer dispatching via the master agent over BullMQ
 * to avoid HTTP timeout constraints.
 *
 * Request body (all optional — omit all to score every unscored company):
 *   {
 *     companyIds?: string[]   — score specific companies by UUID
 *     sector?:     string     — score all companies in a sector
 *   }
 *
 * Response (202):
 *   ScoringRunResult — taskId, mode, totalRequested, totalScored,
 *                      totalFailed, results[], modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runScoringAgent } from "@/lib/agents/sub-agents/scoring-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyIds: z.array(z.string().uuid()).optional(),
  sector: z
    .enum(["Physical AI", "Drones & UAV", "FinTech", "Autonomous EVs"])
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
    // Body is optional — empty body is valid (scores all unscored companies)
    body = {};
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const { companyIds, sector } = parsed.data;

  const supabase = createAdminClient();

  const taskInput: Record<string, unknown> = {
    ...(companyIds ? { companyIds } : {}),
    ...(sector     ? { sector }     : {}),
  };

  // Create agent_tasks row so the monitor shows it immediately with progress
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "scoring", status: "queued", input: taskInput })
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
    const result = await runScoringAgent({
      agentName: "scoring",
      taskId:    taskRow.id as string,
      payload:   taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/scoring] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Scoring agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
