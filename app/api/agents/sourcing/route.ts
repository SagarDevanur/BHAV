/**
 * POST /api/agents/sourcing
 *
 * Triggers the Sourcing agent to discover new deSPAC target companies.
 * Searches SEC EDGAR and Google News, then uses Claude to extract and
 * insert new company records into Supabase.
 *
 * Request body:
 *   {
 *     sector?:      "Physical AI" | "Drones & UAV" | "FinTech" | "Autonomous EVs"
 *     keywords?:    string[]     // extra search terms forwarded to the query
 *     maxResults?:  number       // cap on companies Claude returns (default 20)
 *   }
 *
 * Response (202):
 *   SourcingRunResult — taskId, sector, searchQuery, counts of inserted vs skipped
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runSourcingAgent } from "@/lib/agents/sub-agents/sourcing-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  sector: z
    .enum(["Physical AI", "Drones & UAV", "FinTech", "Autonomous EVs"])
    .optional(),
  keywords:   z.array(z.string()).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
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

  const { sector, keywords, maxResults } = parsed.data;
  const supabase = createAdminClient();

  const taskInput: Record<string, unknown> = {
    sector: sector ?? null,
    searchCriteria: {
      keywords:   keywords ?? [],
      maxResults: maxResults ?? 20,
    },
  };

  // Create agent_tasks row so the monitor shows it immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "sourcing", status: "queued", input: taskInput })
    .select("id")
    .single();

  if (taskInsertError || !taskRow) {
    return NextResponse.json(
      { error: `Failed to create agent_tasks row: ${taskInsertError?.message ?? "no row returned"}` },
      { status: 500 }
    );
  }

  try {
    const result = await runSourcingAgent({
      agentName: "sourcing",
      taskId:    taskRow.id as string,
      payload:   taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/sourcing] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Sourcing agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
