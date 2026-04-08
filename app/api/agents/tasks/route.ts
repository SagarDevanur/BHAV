// GET /api/agents/tasks
// Returns the 100 most recent agent_tasks plus today's summary counts.
// Used by the agent monitor page to poll for live updates.
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentTask } from "@/types/database";

export interface TasksSummary {
  todayTotal: number;
  running: number;
  completed: number;
  failed: number;
}

export interface TasksResponse {
  tasks: AgentTask[];
  summary: TasksSummary;
}

export async function GET() {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const todayIso = startOfToday.toISOString();

  try {
    const [tasksRes, todayRes, runningRes, completedRes, failedRes] =
      await Promise.all([
        supabase
          .from("agent_tasks")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("agent_tasks")
          .select("*", { count: "exact", head: true })
          .gte("created_at", todayIso),
        supabase
          .from("agent_tasks")
          .select("*", { count: "exact", head: true })
          .eq("status", "running"),
        supabase
          .from("agent_tasks")
          .select("*", { count: "exact", head: true })
          .eq("status", "completed")
          .gte("created_at", todayIso),
        supabase
          .from("agent_tasks")
          .select("*", { count: "exact", head: true })
          .eq("status", "failed")
          .gte("created_at", todayIso),
      ]);

    if (tasksRes.error) throw tasksRes.error;

    const response: TasksResponse = {
      tasks: (tasksRes.data ?? []) as AgentTask[],
      summary: {
        todayTotal: todayRes.count ?? 0,
        running: runningRes.count ?? 0,
        completed: completedRes.count ?? 0,
        failed: failedRes.count ?? 0,
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
