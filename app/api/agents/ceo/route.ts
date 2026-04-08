/**
 * POST /api/agents/ceo
 *
 * The only API endpoint that co-founders use to issue instructions to the agent system.
 * Validates the request, runs the CEO agent inline, and returns the full dispatch result
 * so the dashboard can immediately show which agents were triggered and their task IDs.
 *
 * Response (202):
 *   { ceoTaskId, summary, taskType, approvedByHuman, modelUsed, dispatchedJobs[] }
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { runCeoAgent } from "@/lib/agents/ceo-agent";

// ---------------------------------------------------------------------------
// Input schema — validated before any agent code runs
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  /** Plain English instruction from the co-founder. */
  prompt: z.string().min(1).max(4_000),
  /**
   * Set to true only when the co-founder explicitly approves external actions
   * (sending emails, filing documents, contacting PIPE investors, etc.).
   * Defaults to false — agents will draft but never send without this flag.
   */
  approvedByHuman: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // Auth — only authenticated co-founders may reach this endpoint
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate with Zod
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 422 }
    );
  }

  // Run CEO agent inline — returns immediately with dispatched job IDs
  try {
    const result = await runCeoAgent({
      prompt:          parsed.data.prompt,
      founderId:       userId,
      approvedByHuman: parsed.data.approvedByHuman,
    });

    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    console.error("[POST /api/agents/ceo] unhandled error:", err);
    const message = err instanceof Error ? err.message : "CEO agent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
