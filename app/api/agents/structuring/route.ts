/**
 * POST /api/agents/structuring
 *
 * Triggers the Structuring agent to design a full deSPAC deal structure for an
 * approved target. Requires approvedByHuman: true — the agent will reject the
 * request otherwise and log the failure to agent_tasks.
 *
 * Request body:
 *   {
 *     companyId:       string (uuid)   — target company
 *     approvedByHuman: boolean         — must be true to proceed
 *     spac_trust_size?: string         — default "$150M"
 *     coFounderPreferences?: {
 *       maxDilution?:       string     — e.g. "20%"
 *       earnoutPreference?: boolean    — whether co-founders want earnout provisions
 *       pipeTarget?:        string     — e.g. "$30M"
 *     }
 *   }
 *
 * Response (202):
 *   StructuringRunResult — taskId, companyId, companyName, recommendedStructure,
 *                          alternativeStructures, earnoutProvisions, sponsorEconomics,
 *                          valuationRange, keyDealTerms, risks, rationale,
 *                          reviewRequired, approvedByHuman, modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runStructuringAgent } from "@/lib/agents/sub-agents/structuring-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId:       z.string().uuid(),
  approvedByHuman: z.boolean(),
  spac_trust_size: z.string().optional(),
  coFounderPreferences: z
    .object({
      maxDilution:       z.string().optional(),
      earnoutPreference: z.boolean().optional(),
      pipeTarget:        z.string().optional(),
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

  const { companyId, approvedByHuman, spac_trust_size, coFounderPreferences } = parsed.data;

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

  // Structuring is only valid for companies that have been approved or further progressed
  const allowedStatuses = ["approved", "loi_sent"];
  if (!allowedStatuses.includes(company.status)) {
    return NextResponse.json(
      {
        error: `Company status is "${company.status}". Deal structuring is only available for companies with status "approved" or "loi_sent".`,
      },
      { status: 422 }
    );
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    approvedByHuman,
    ...(spac_trust_size        ? { spac_trust_size }        : {}),
    ...(coFounderPreferences   ? { coFounderPreferences }   : {}),
  };

  // Create agent_tasks row so the monitor reflects the job immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "structuring", status: "queued", input: taskInput })
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
    const result = await runStructuringAgent({
      agentName:       "structuring",
      taskId:          taskRow.id as string,
      companyId,
      approvedByHuman,
      payload:         taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/structuring] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Structuring agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
