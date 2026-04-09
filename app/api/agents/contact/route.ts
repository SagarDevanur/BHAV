/**
 * POST /api/agents/contact
 *
 * Triggers the Contact agent to enrich a company's decision-maker contacts.
 * Scrapes the company website, queries Hunter.io (if key present), then uses
 * Claude to extract and upsert structured contact records into Supabase.
 *
 * Request body:
 *   { companyId: string (uuid) }
 *
 * Response (202):
 *   ContactRunResult — taskId, companyId, contactsUpserted, sourcesUsed,
 *                      enrichmentSummary, modelUsed
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { runContactAgent } from "@/lib/agents/sub-agents/contact-agent";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  companyId: z.string().uuid(),
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

  const { companyId } = parsed.data;
  const supabase = createAdminClient();

  // ------------------------------------------------------------------
  // Fetch the company record to supply companyName and website
  // ------------------------------------------------------------------
  const { data: company, error: fetchError } = await supabase
    .from("companies")
    .select("id, name, website")
    .eq("id", companyId)
    .single();

  if (fetchError || !company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const taskInput: Record<string, unknown> = {
    companyId,
    companyName: company.name,
    website:     company.website,
  };

  // Create agent_tasks row so the monitor shows it immediately
  const { data: taskRow, error: taskInsertError } = await supabase
    .from("agent_tasks")
    .insert({ agent_name: "contact", status: "queued", input: taskInput })
    .select("id")
    .single();

  if (taskInsertError || !taskRow) {
    return NextResponse.json(
      { error: `Failed to create agent_tasks row: ${taskInsertError?.message ?? "no row returned"}` },
      { status: 500 }
    );
  }

  try {
    const result = await runContactAgent({
      agentName:  "contact",
      taskId:     taskRow.id as string,
      companyId,
      payload:    taskInput,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/contact] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Contact agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
