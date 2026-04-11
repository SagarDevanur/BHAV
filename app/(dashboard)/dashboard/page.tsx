// Deal pipeline — server component fetches initial data, client handles live refresh.
import { createAdminClient } from "@/lib/supabase/admin";
import { DealPipeline } from "@/components/dashboard/deal-pipeline";
import type { Company, AgentTask } from "@/types/database";

async function getDashboardData() {
  const supabase = createAdminClient();

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const todayIso = startOfToday.toISOString();

  const [companiesRes, tasksRes, todayRes, runningRes, completedRes, failedRes] =
    await Promise.all([
      supabase
        .from("companies")
        .select("id, name, sector, despac_score, status, updated_at")
        .order("despac_score", { ascending: false }),
      supabase
        .from("agent_tasks")
        .select("id, agent_name, status, error, created_at, started_at, completed_at")
        .order("created_at", { ascending: false })
        .limit(20),
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

  return {
    companies: (companiesRes.data ?? []) as Pick<
      Company,
      "id" | "name" | "sector" | "despac_score" | "status" | "updated_at"
    >[],
    tasks: (tasksRes.data ?? []) as Pick<
      AgentTask,
      "id" | "agent_name" | "status" | "error" | "created_at" | "started_at" | "completed_at"
    >[],
    summary: {
      todayTotal: todayRes.count ?? 0,
      running:    runningRes.count ?? 0,
      completed:  completedRes.count ?? 0,
      failed:     failedRes.count ?? 0,
    },
  };
}

export default async function DashboardPage() {
  const initialData = await getDashboardData();
  return <DealPipeline initialData={initialData} />;
}
