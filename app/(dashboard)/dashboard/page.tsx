// Deal pipeline overview — server component, fetches directly from Supabase.
import { createAdminClient } from "@/lib/supabase/admin";
import { PromptConsole } from "@/components/dashboard/PromptConsole";
import type { Company, AgentTask, CompanyStatus } from "@/types/database";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function scoreColor(score: number): string {
  if (score >= 70) return "text-green-600 dark:text-green-400";
  if (score >= 45) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function scoreBg(score: number): string {
  if (score >= 70) return "bg-green-500";
  if (score >= 45) return "bg-amber-500";
  return "bg-red-500";
}

const STATUS_STYLES: Record<CompanyStatus, string> = {
  sourced:   "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  scoring:   "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400",
  reviewed:  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  approved:  "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  rejected:  "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  loi_sent:  "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
};

const AGENT_STATUS_STYLES: Record<string, string> = {
  queued:    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  running:   "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  completed: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  failed:    "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
};

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function getDashboardData() {
  const supabase = createAdminClient();

  const [companiesRes, tasksRes] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, sector, despac_score, status, updated_at")
      .order("despac_score", { ascending: false }),
    supabase
      .from("agent_tasks")
      .select("id, agent_name, status, error, created_at, started_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const companies = (companiesRes.data ?? []) as Pick<
    Company,
    "id" | "name" | "sector" | "despac_score" | "status" | "updated_at"
  >[];

  const tasks = (tasksRes.data ?? []) as Pick<
    AgentTask,
    "id" | "agent_name" | "status" | "error" | "created_at" | "started_at" | "completed_at"
  >[];

  const totalCompanies = companies.length;
  const approvedCount = companies.filter(
    (c) => c.status === "approved" || c.status === "loi_sent"
  ).length;
  const scoredCompanies = companies.filter((c) => c.despac_score !== null);
  const avgScore =
    scoredCompanies.length > 0
      ? Math.round(
          scoredCompanies.reduce((sum, c) => sum + (c.despac_score ?? 0), 0) /
            scoredCompanies.length
        )
      : null;
  const runningAgents = tasks.filter((t) => t.status === "running").length;
  const topTargets = companies.filter((c) => c.despac_score !== null).slice(0, 6);

  return { totalCompanies, approvedCount, avgScore, runningAgents, topTargets, tasks };
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-6 py-5">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <p className={`mt-2 text-3xl font-bold ${accent ?? "text-gray-900 dark:text-white"}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const { totalCompanies, approvedCount, avgScore, runningAgents, topTargets, tasks } =
    await getDashboardData();

  return (
    <div className="space-y-8">
      {/* Page heading */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Deal Pipeline</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Live overview of BHAV acquisition targets and agent activity.
        </p>
      </div>

      {/* Instruction console */}
      <PromptConsole />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Total Companies"
          value={totalCompanies}
          sub="tracked targets"
        />
        <StatCard
          label="Approved Targets"
          value={approvedCount}
          sub="approved or LOI sent"
          accent="text-green-600 dark:text-green-400"
        />
        <StatCard
          label="Avg deSPAC Score"
          value={avgScore !== null ? avgScore : "—"}
          sub="across scored targets"
          accent={avgScore !== null ? scoreColor(avgScore) : undefined}
        />
        <StatCard
          label="Agents Running"
          value={runningAgents}
          sub="active right now"
          accent={runningAgents > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
        />
      </div>

      {/* Top scored targets */}
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Top Scored Targets
        </h2>
        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          {topTargets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">No scored companies yet</p>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Run the sourcing and scoring agents to populate targets.
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-xs uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  <th className="px-5 py-3 text-left font-medium">Company</th>
                  <th className="px-5 py-3 text-left font-medium">Sector</th>
                  <th className="px-5 py-3 text-left font-medium">Score</th>
                  <th className="px-5 py-3 text-left font-medium">Status</th>
                  <th className="px-5 py-3 text-left font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {topTargets.map((company) => (
                  <tr
                    key={company.id}
                    className="group hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                  >
                    <td className="px-5 py-3.5 font-medium text-gray-900 dark:text-white">
                      {company.name}
                    </td>
                    <td className="px-5 py-3.5 text-gray-500 dark:text-gray-400">
                      {company.sector ?? "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      {company.despac_score !== null ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 rounded-full bg-gray-100 dark:bg-gray-800">
                            <div
                              className={`h-1.5 rounded-full ${scoreBg(company.despac_score)}`}
                              style={{ width: `${company.despac_score}%` }}
                            />
                          </div>
                          <span className={`font-semibold tabular-nums ${scoreColor(company.despac_score)}`}>
                            {company.despac_score}
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[company.status]}`}
                      >
                        {company.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-gray-400 dark:text-gray-500 text-xs">
                      {formatRelativeTime(company.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Recent agent activity */}
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Recent Agent Activity
        </h2>
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-50 dark:divide-gray-800">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">No agent activity yet</p>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Submit a prompt above to kick off your first agent run.
              </p>
            </div>
          ) : (
            tasks.map((task) => (
              <div key={task.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-white capitalize text-sm">
                      {task.agent_name}
                    </span>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${AGENT_STATUS_STYLES[task.status] ?? AGENT_STATUS_STYLES.queued}`}
                    >
                      {task.status}
                    </span>
                  </div>
                  {task.error && (
                    <p className="mt-0.5 truncate text-xs text-red-500 dark:text-red-400">
                      {task.error}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">
                  {formatRelativeTime(task.created_at)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
