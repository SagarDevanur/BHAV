"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { PromptConsole } from "./PromptConsole";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import type { Company, CompanyStatus, AgentTask } from "@/types/database";
import type { AgentName } from "@/types/agents";
import type { TasksResponse } from "@/app/api/agents/tasks/route";

// ─── Types ────────────────────────────────────────────────────────────────────

type CompanySlim = Pick<
  Company,
  "id" | "name" | "sector" | "despac_score" | "status" | "updated_at"
>;

type TaskSlim = Pick<
  AgentTask,
  "id" | "agent_name" | "status" | "error" | "created_at" | "started_at" | "completed_at"
>;

interface DashboardData {
  companies: CompanySlim[];
  tasks: TaskSlim[];
  summary: { todayTotal: number; running: number; completed: number; failed: number };
}

export interface DealPipelineProps {
  initialData: DashboardData;
}

// ─── Kanban stages ────────────────────────────────────────────────────────────

const PIPELINE_STAGES: { key: string; label: string; statuses: CompanyStatus[]; info: string }[] = [
  { key: "sourced",   label: "Sourced",   statuses: ["sourced"],              info: "Found, not yet scored" },
  { key: "scored",    label: "Scored",    statuses: ["scoring", "reviewed"],  info: "CFO scored, awaiting approval" },
  { key: "loi",       label: "LOI",       statuses: ["approved", "loi_sent"], info: "Letter of Intent drafted" },
  { key: "diligence", label: "Diligence", statuses: [],                       info: "Under active due diligence" },
  { key: "pipe",      label: "PIPE",      statuses: [],                       info: "Investor outreach in progress" },
  { key: "announced", label: "Announced", statuses: [],                       info: "Deal publicly announced" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function scoreColor(score: number) {
  if (score >= 70) return { text: "text-emerald-700", bar: "bg-emerald-500", bg: "bg-emerald-50" };
  if (score >= 40) return { text: "text-amber-700",   bar: "bg-amber-500",   bg: "bg-amber-50" };
  return              { text: "text-red-700",     bar: "bg-red-500",     bg: "bg-red-50" };
}

const AGENT_COLOR: Record<string, string> = {
  ceo:    "text-orange-600",
  cfo:    "text-teal-600",
  master: "text-purple-600",
};

const STATUS_TASK: Record<string, { dot: string; label: string }> = {
  running:   { dot: "bg-blue-500 animate-pulse", label: "Running" },
  completed: { dot: "bg-emerald-500",            label: "Done" },
  failed:    { dot: "bg-red-500",                label: "Failed" },
  queued:    { dot: "bg-slate-300",              label: "Queued" },
};

function agentColor(name: AgentName) {
  return AGENT_COLOR[name] ?? "text-blue-600";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  accent,
  pulse,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  pulse?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-6 py-5 shadow-sm">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        {label}
        {pulse && (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        )}
      </p>
      <p className={`mt-2 text-4xl font-bold tabular-nums tracking-tight ${accent ?? "text-slate-900"}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function KanbanColumn({ label, companies, info }: { label: string; companies: CompanySlim[]; info: string }) {
  const count = companies.length;
  return (
    <div className="flex w-44 shrink-0 flex-col gap-2">
      <div className="group flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
          {label}
          {/* Info icon — hidden until parent heading is hovered */}
          <span className="opacity-0 transition-opacity duration-100 group-hover:opacity-100">
            <InfoTooltip text={info} />
          </span>
        </span>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold tabular-nums text-slate-600">
          {count}
        </span>
      </div>

      <div className="flex min-h-[96px] flex-col gap-1.5">
        {companies.slice(0, 5).map((c) => {
          const sc = c.despac_score !== null ? scoreColor(c.despac_score) : null;
          return (
            <div
              key={c.id}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-sm transition-shadow hover:shadow-md"
            >
              <p className="truncate text-xs font-semibold text-slate-800">{c.name}</p>
              {c.despac_score !== null && sc && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <div className="h-1 flex-1 rounded-full bg-slate-100">
                    <div
                      className={`h-1 rounded-full ${sc.bar}`}
                      style={{ width: `${c.despac_score}%` }}
                    />
                  </div>
                  <span className={`shrink-0 text-[10px] font-bold tabular-nums ${sc.text}`}>
                    {c.despac_score}
                  </span>
                </div>
              )}
            </div>
          );
        })}
        {count > 5 && (
          <p className="pl-1 text-xs text-slate-400">+{count - 5} more</p>
        )}
        {count === 0 && (
          <div className="flex h-16 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50">
            <span className="text-xs text-slate-300">—</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function DealPipeline({ initialData }: DealPipelineProps) {
  const [data, setData]           = useState<DashboardData>(initialData);
  const [syncing, setSyncing]     = useState(false);
  const [tickerIdx, setTickerIdx] = useState(0);
  const tickerTimer = useRef<ReturnType<typeof setInterval>>();

  // ── Polling ───────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      const [cRes, tRes] = await Promise.all([
        fetch("/api/companies"),
        fetch("/api/agents/tasks"),
      ]);
      if (!cRes.ok || !tRes.ok) return;
      const [companies, tr] = await Promise.all([
        cRes.json() as Promise<CompanySlim[]>,
        tRes.json() as Promise<TasksResponse>,
      ]);
      setData({ companies, tasks: tr.tasks, summary: tr.summary });
    } catch {
      // retry next cycle
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  // ── Ticker rotation ───────────────────────────────────────────────────────
  const recentTasks = data.tasks.slice(0, 3);
  useEffect(() => {
    if (recentTasks.length < 2) return;
    tickerTimer.current = setInterval(
      () => setTickerIdx((i) => (i + 1) % recentTasks.length),
      3_000,
    );
    return () => clearInterval(tickerTimer.current);
  }, [recentTasks.length]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const { companies, tasks, summary } = data;

  const scored = companies.filter((c) => c.despac_score !== null);
  const avgScore =
    scored.length > 0
      ? Math.round(scored.reduce((s, c) => s + (c.despac_score ?? 0), 0) / scored.length)
      : null;
  const approvedCount = companies.filter(
    (c) => c.status === "approved" || c.status === "loi_sent",
  ).length;
  const topDeals = [...scored]
    .sort((a, b) => (b.despac_score ?? 0) - (a.despac_score ?? 0))
    .slice(0, 5);
  const kanban = PIPELINE_STAGES.map((stage) => ({
    ...stage,
    companies: companies.filter((c) => (stage.statuses as string[]).includes(c.status)),
  }));

  const ticker = recentTasks[tickerIdx];
  const tickerStatus = ticker ? (STATUS_TASK[ticker.status] ?? STATUS_TASK.queued) : null;

  return (
    <div className="flex flex-col gap-7">
      {/* ── Activity ticker banner ────────────────────────────────────────── */}
      {ticker && tickerStatus && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2.5">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-50" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
          <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">
            Live
          </span>
          <span className="text-slate-300">·</span>
          <span className={`text-xs font-semibold capitalize ${agentColor(ticker.agent_name)}`}>
            {ticker.agent_name} agent
          </span>
          <span className="text-xs text-slate-500">
            {ticker.status} · {rel(ticker.created_at)}
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
            {syncing && (
              <svg className="h-3 w-3 animate-spin text-slate-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            Refreshes every 5s
          </span>
        </div>
      )}

      {/* ── Page heading ──────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Deal Pipeline</h1>
        <p className="mt-1 text-sm text-slate-500">
          Live overview of BHAV acquisition targets and agent activity.
        </p>
      </div>

      {/* ── Metric cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Total Targets"
          value={companies.length}
          sub={`${scored.length} scored`}
        />
        <MetricCard
          label="Approved"
          value={approvedCount}
          sub="approved or LOI sent"
          accent="text-blue-700"
        />
        <MetricCard
          label="Avg deSPAC Score"
          value={avgScore ?? "—"}
          sub={scored.length > 0 ? `across ${scored.length} companies` : "no scores yet"}
          accent={
            avgScore === null ? "text-slate-400" :
            avgScore >= 70    ? "text-emerald-700" :
            avgScore >= 40    ? "text-amber-700" : "text-red-700"
          }
        />
        <MetricCard
          label="Agents Running"
          value={summary.running}
          sub={summary.running > 0 ? "active right now" : "all agents idle"}
          accent={summary.running > 0 ? "text-blue-700" : "text-slate-400"}
          pulse={summary.running > 0}
        />
      </div>

      {/* ── CEO Prompt Console ───────────────────────────────────────────── */}
      <PromptConsole />

      {/* ── Kanban pipeline ──────────────────────────────────────────────── */}
      <section>
        <h2 className="group mb-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
          Pipeline View
          <span className="opacity-0 transition-opacity duration-100 group-hover:opacity-100">
            <InfoTooltip text="Companies progressing through deal stages" />
          </span>
        </h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-5 shadow-sm">
          <div className="flex gap-5">
            {kanban.map((stage) => (
              <KanbanColumn
                key={stage.key}
                label={stage.label}
                companies={stage.companies}
                info={stage.info}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ── Top Deals Today ──────────────────────────────────────────────── */}
      {topDeals.length > 0 && (
        <section>
          <h2 className="group mb-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Top Deals Today
            <span className="opacity-0 transition-opacity duration-100 group-hover:opacity-100">
              <InfoTooltip text="Highest scored targets by CFO agent" />
            </span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {topDeals.map((c, i) => {
              const sc = scoreColor(c.despac_score!);
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-4 border-b border-slate-100 px-5 py-3.5 last:border-b-0 hover:bg-slate-50 transition-colors"
                >
                  <span className="w-5 shrink-0 text-center text-sm font-bold text-slate-300">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{c.name}</p>
                    <p className="text-xs text-slate-400">{c.sector ?? "—"}</p>
                  </div>
                  <div className="flex w-44 shrink-0 items-center gap-2.5">
                    <div className="h-1.5 flex-1 rounded-full bg-slate-100">
                      <div
                        className={`h-1.5 rounded-full transition-all duration-500 ${sc.bar}`}
                        style={{ width: `${c.despac_score}%` }}
                      />
                    </div>
                    <span className={`w-8 shrink-0 text-sm font-bold tabular-nums ${sc.text}`}>
                      {c.despac_score}
                    </span>
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">{rel(c.updated_at)}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Recent Activity ───────────────────────────────────────────────── */}
      {tasks.length > 0 && (
        <section>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Recent Agent Activity
          </h2>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm divide-y divide-slate-100">
            {tasks.slice(0, 8).map((t) => {
              const st = STATUS_TASK[t.status] ?? STATUS_TASK.queued;
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                  <span className={`shrink-0 text-xs font-semibold capitalize ${agentColor(t.agent_name)}`}>
                    {t.agent_name}
                  </span>
                  <span className="flex-1 truncate text-xs text-slate-500">
                    {t.status}
                    {t.error && <span className="text-red-500"> — {t.error}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{rel(t.created_at)}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
