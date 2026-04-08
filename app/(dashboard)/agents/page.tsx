// Agent monitor — server component fetches initial data, client component polls every 10s.
import { createAdminClient } from "@/lib/supabase/admin";
import { AgentMonitor } from "@/components/dashboard/agent-monitor";
import type { TasksResponse, TasksSummary } from "@/app/api/agents/tasks/route";
import type { AgentTask } from "@/types/database";

async function getInitialData(): Promise<TasksResponse> {
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

    const summary: TasksSummary = {
      todayTotal: todayRes.count ?? 0,
      running: runningRes.count ?? 0,
      completed: completedRes.count ?? 0,
      failed: failedRes.count ?? 0,
    };

    return {
      tasks: (tasksRes.data ?? []) as AgentTask[],
      summary,
    };
  } catch (err) {
    console.error("Failed to fetch agent tasks:", err);
    return {
      tasks: [],
      summary: { todayTotal: 0, running: 0, completed: 0, failed: 0 },
    };
  }
}

export default async function AgentsPage() {
  const initialData = await getInitialData();
  return <AgentMonitor initialData={initialData} />;
}
