/**
 * POST /api/agents/cfo
 *
 * Scores a single company using the CFO agent.
 * Creates an agent_tasks row, runs the CFO agent inline, and returns
 * the full scoring result so the dashboard can display it immediately.
 *
 * Request body:
 *   { companyId: string (uuid), estimated_revenue?: string, approvedByHuman?: boolean }
 *
 * Response (202):
 *   { taskId, companyId, despac_score, score_breakdown, rationale,
 *     recommendation, confidence, modelUsed }
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCfoAgent } from "@/lib/agents/cfo-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  /** UUID of the company to score — must exist in the companies table. */
  companyId: z.string().uuid(),
  /**
   * Optional free-text revenue hint, e.g. "$12M ARR".
   * When provided it supplements whatever the LLM can infer from the blurb.
   */
  estimated_revenue: z.string().optional(),
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

  const { companyId, estimated_revenue, approvedByHuman } = parsed.data;
  const supabase = createAdminClient();

  // ------------------------------------------------------------------
  // Fetch the company record — validates companyId and supplies the
  // fields the CFO agent payload needs (sector, valuation, blurb, etc.)
  // ------------------------------------------------------------------
  const { data: company, error: fetchError } = await supabase
    .from("companies")
    .select(
      "id, name, sector, sub_sector, estimated_valuation, last_round, blurb"
    )
    .eq("id", companyId)
    .single();

  if (fetchError || !company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  // ------------------------------------------------------------------
  // Create agent_tasks row upfront so the monitor shows it immediately.
  // runCfoAgent will update the status to "running" then "completed" / "failed".
  // ------------------------------------------------------------------
  const taskPayload: Record<string, unknown> = {
    companyId,
    name: company.name,
    sector: company.sector,
    sub_sector: company.sub_sector,
    estimated_revenue: estimated_revenue ?? null,
    estimated_valuation: company.estimated_valuation,
    last_round: company.last_round,
    blurb: company.blurb,
    approvedByHuman,
  };

  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({
      agent_name: "cfo",
      status: "queued",
      input: taskPayload,
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
  // Run the CFO agent inline and return the full structured result.
  // AgentInput.payload carries the company fields; AgentInput.companyId
  // and AgentInput.taskId are set at the top level as required by the type.
  // ------------------------------------------------------------------
  try {
    const result = await runCfoAgent({
      agentName: "cfo",
      taskId: taskRow.id as string,
      companyId,
      approvedByHuman,
      payload: taskPayload,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/cfo] unhandled error:", err);
    const message = err instanceof Error ? err.message : "CFO agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
