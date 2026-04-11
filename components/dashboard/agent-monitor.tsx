"use client";

import { useState, useEffect, useCallback } from "react";
import type { AgentTask, AgentTaskStatus } from "@/types/database";
import type { AgentName } from "@/types/agents";
import type { TasksResponse, TasksSummary } from "@/app/api/agents/tasks/route";

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT_BADGE: Record<AgentName, { bg: string; text: string }> = {
  ceo:          { bg: "bg-orange-50",  text: "text-orange-700" },
  cfo:          { bg: "bg-teal-50",    text: "text-teal-700" },
  master:       { bg: "bg-purple-50",  text: "text-purple-700" },
  sourcing:     { bg: "bg-blue-50",    text: "text-blue-700" },
  contact:      { bg: "bg-blue-50",    text: "text-blue-700" },
  scoring:      { bg: "bg-blue-50",    text: "text-blue-700" },
  loi:          { bg: "bg-blue-50",    text: "text-blue-700" },
  outreach:     { bg: "bg-blue-50",    text: "text-blue-700" },
  sec:          { bg: "bg-blue-50",    text: "text-blue-700" },
  narrative:    { bg: "bg-blue-50",    text: "text-blue-700" },
  structuring:  { bg: "bg-blue-50",    text: "text-blue-700" },
  optimization: { bg: "bg-blue-50",    text: "text-blue-700" },
  pipe:         { bg: "bg-blue-50",    text: "text-blue-700" },
  redemption:   { bg: "bg-blue-50",    text: "text-blue-700" },
};

const STATUS_BADGE: Record<AgentTaskStatus, { bg: string; text: string; dot: string; label: string }> = {
  queued:    { bg: "bg-slate-100",   text: "text-slate-600",   dot: "bg-slate-400",   label: "Queued" },
  running:   { bg: "bg-blue-50",    text: "text-blue-700",    dot: "bg-blue-500",    label: "Running" },
  completed: { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500", label: "Completed" },
  failed:    { bg: "bg-red-50",     text: "text-red-700",     dot: "bg-red-500",     label: "Failed" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function summariseInput(agentName: AgentName, input: Record<string, unknown>): string {
  if (agentName === "ceo" && typeof input.prompt === "string") {
    const p = input.prompt.trim();
    return p.length > 100 ? p.slice(0, 100) + "…" : p;
  }
  if (typeof input.companyId === "string") {
    const company = input.company as Record<string, unknown> | undefined;
    const name = typeof company?.name === "string" ? company.name : null;
    return name ? `Company: ${name}` : `Company ID: ${input.companyId.slice(0, 8)}…`;
  }
  if (agentName === "master") {
    const out = input.ceoOutput as Record<string, unknown> | undefined;
    if (typeof out?.action === "string") return `Action: ${out.action}`;
  }
  if (agentName === "sourcing" && typeof input.sector === "string") {
    return `Sector: ${input.sector}`;
  }
  return `${agentName} task`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getElapsed(task: AgentTask, now: number): string {
  if (task.status === "queued") {
    return formatDuration(now - new Date(task.created_at).getTime()) + " ago";
  }
  if (task.status === "running" && task.started_at) {
    return formatDuration(now - new Date(task.started_at).getTime()) + " elapsed";
  }
  if (
    (task.status === "completed" || task.status === "failed") &&
    task.started_at && task.completed_at
  ) {
    return formatDuration(
      new Date(task.completed_at).getTime() - new Date(task.started_at).getTime(),
    );
  }
  return "—";
}

function runningProgress(startedAt: string | null): number {
  if (!startedAt) return 10;
  const elapsed = Date.now() - new Date(startedAt).getTime();
  return Math.min(90, Math.round((elapsed / (elapsed + 30_000)) * 90));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: number | string;
  accent?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1.5 text-3xl font-bold tabular-nums ${accent ?? "text-slate-900"}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function AgentBadge({ name }: { name: AgentName }) {
  const cfg = AGENT_BADGE[name] ?? AGENT_BADGE.sourcing;
  return (
    <span className={`inline-flex shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold capitalize ${cfg.bg} ${cfg.text}`}>
      {name}
    </span>
  );
}

function StatusPill({ status }: { status: AgentTaskStatus }) {
  const cfg = STATUS_BADGE[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.text}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${cfg.dot} ${status === "running" ? "animate-pulse" : ""}`}
      />
      {cfg.label}
    </span>
  );
}

function StatusIcon({ status }: { status: AgentTaskStatus }) {
  if (status === "completed") {
    return (
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50">
        <svg className="h-3.5 w-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-50">
        <svg className="h-3.5 w-3.5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
    );
  }
  if (status === "running") {
    return (
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50">
        <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
      </div>
    );
  }
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100">
      <span className="h-2 w-2 rounded-full bg-slate-400" />
    </div>
  );
}

// ─── Task row ─────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  now,
  index,
  retryingIds,
  onRetry,
}: {
  task: AgentTask;
  now: number;
  index: number;
  retryingIds: Set<string>;
  onRetry: (id: string) => void;
}) {
  const progress = task.status === "running" ? runningProgress(task.started_at) : null;

  return (
    <tr className={index % 2 === 0 ? "bg-white" : "bg-slate-50/70"}>
      {/* Status icon */}
      <td className="w-10 px-4 py-3.5">
        <StatusIcon status={task.status} />
      </td>

      {/* Agent + summary */}
      <td className="px-3 py-3.5">
        <div className="flex items-center gap-2">
          <AgentBadge name={task.agent_name} />
        </div>
        <p className="mt-1 max-w-sm truncate text-xs text-slate-500">
          {summariseInput(task.agent_name, task.input)}
        </p>
        {progress !== null && (
          <div className="mt-2 max-w-xs">
            <div className="h-1 w-full rounded-full bg-slate-200">
              <div
                className="h-1 rounded-full bg-blue-500 transition-all duration-1000"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
        {task.status === "failed" && task.error && (
          <p className="mt-1 truncate text-xs text-red-600">{task.error}</p>
        )}
      </td>

      {/* Status pill */}
      <td className="px-3 py-3.5">
        <StatusPill status={task.status} />
      </td>

      {/* Elapsed */}
      <td className="px-3 py-3.5 text-right">
        <p className="text-xs tabular-nums text-slate-600">{getElapsed(task, now)}</p>
        <p className="mt-0.5 text-[10px] tabular-nums text-slate-400">{formatTime(task.created_at)}</p>
      </td>

      {/* Retry */}
      <td className="px-4 py-3.5 text-right">
        {task.status === "failed" && (
          <button
            onClick={() => onRetry(task.id)}
            disabled={retryingIds.has(task.id)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {retryingIds.has(task.id) ? "Retrying…" : "Retry"}
          </button>
        )}
      </td>
    </tr>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AgentMonitor({ initialData }: { initialData: TasksResponse }) {
  const [tasks, setTasks]           = useState<AgentTask[]>(initialData.tasks);
  const [summary, setSummary]       = useState<TasksSummary>(initialData.summary);
  const [lastRefreshed, setLast]    = useState<Date>(new Date());
  const [polling, setPolling]       = useState(false);
  const [retryingIds, setRetrying]  = useState<Set<string>>(new Set());
  const now = Date.now();

  // ── Polling ───────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setPolling(true);
    try {
      const res = await fetch("/api/agents/tasks");
      if (!res.ok) return;
      const data: TasksResponse = await res.json();
      setTasks(data.tasks);
      setSummary(data.summary);
      setLast(new Date());
    } catch {
      // silently ignore
    } finally {
      setPolling(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  // ── Retry ─────────────────────────────────────────────────────────────────
  const handleRetry = useCallback(async (taskId: string) => {
    setRetrying((p) => new Set(p).add(taskId));
    try {
      const res = await fetch(`/api/agents/${taskId}/retry`, { method: "POST" });
      if (res.ok) await refresh();
    } catch {
      // silently ignore
    } finally {
      setRetrying((p) => { const n = new Set(p); n.delete(taskId); return n; });
    }
  }, [refresh]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const successRate =
    summary.completed + summary.failed > 0
      ? Math.round((summary.completed / (summary.completed + summary.failed)) * 100)
      : null;

  return (
    <div className="flex flex-col gap-7">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Agent Monitor</h1>
          <p className="mt-1 text-sm text-slate-500">
            Live task feed · auto-refresh every 5s
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          {polling && (
            <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          <span>
            Updated{" "}
            {lastRefreshed.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </div>
      </div>

      {/* ── Stat cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Tasks Today"   value={summary.todayTotal} sub="dispatched" />
        <StatCard
          label="Running"
          value={summary.running}
          accent={summary.running > 0 ? "text-blue-700" : "text-slate-400"}
          sub={summary.running > 0 ? "active now" : "all idle"}
        />
        <StatCard
          label="Completed"
          value={summary.completed}
          accent="text-emerald-700"
          sub="today"
        />
        <StatCard
          label="Failed"
          value={summary.failed}
          accent={summary.failed > 0 ? "text-red-700" : "text-slate-400"}
          sub="today"
        />
        <StatCard
          label="Success Rate"
          value={successRate !== null ? `${successRate}%` : "—"}
          accent={
            successRate === null      ? "text-slate-400" :
            successRate >= 80         ? "text-emerald-700" :
            successRate >= 50         ? "text-amber-700" : "text-red-700"
          }
          sub="completed ÷ total"
        />
      </div>

      {/* ── Activity table ─────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
          Activity Feed
        </h2>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
                <svg className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3" />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-600">No agent activity yet</p>
              <p className="mt-1 text-sm text-slate-400">
                Submit a prompt from the Deal Pipeline to get started.
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="w-10 px-4 py-3" />
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Agent / Task
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Status
                  </th>
                  <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Duration
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tasks.slice(0, 20).map((task, i) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    now={now}
                    index={i}
                    retryingIds={retryingIds}
                    onRetry={handleRetry}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
