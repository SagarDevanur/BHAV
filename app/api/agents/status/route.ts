// GET /api/agents/status — returns how many agent_tasks are currently running.
// Polled by AgentStatusIndicator every 10 s to drive the live status dot.
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { count, error } = await supabase
    .from("agent_tasks")
    .select("*", { count: "exact", head: true })
    .eq("status", "running");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const runningCount = count ?? 0;
  return NextResponse.json({ running: runningCount > 0, count: runningCount });
}
