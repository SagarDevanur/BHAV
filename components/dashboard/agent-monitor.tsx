"use client";

import { useState, useEffect, useCallback } from "react";
import type { AgentTask, AgentTaskStatus } from "@/types/database";
import type { AgentName } from "@/types/agents";
import type { TasksResponse, TasksSummary } from "@/app/api/agents/tasks/route";

// ─── Badge config ─────────────────────────────────────────────────────────────

const AGENT_BADGE: Record<AgentName, string> = {
  ceo:          "bg-red-100 text-red-700",
  cfo:          "bg-teal-100 text-teal-700",
  master:       "bg-purple-100 text-purple-700",
  sourcing:     "bg-blue-100 text-blue-700",
  contact:      "bg-blue-100 text-blue-700",
  scoring:      "bg-blue-100 text-blue-700",
  loi:          "bg-blue-100 text-blue-700",
  outreach:     "bg-blue-100 text-blue-700",
  sec:          "bg-blue-100 text-blue-700",
  narrative:    "bg-blue-100 text-blue-700",
  structuring:  "bg-blue-100 text-blue-700",
  optimization: "bg-blue-100 text-blue-700",
  pipe:         "bg-blue-100 text-blue-700",
  redemption:   "bg-blue-100 text-blue-700",
};

const STATUS_BADGE: Record<AgentTaskStatus, { label: string; cls: string }> = {
  queued:    { label: "Queued",    cls: "bg-gray-100 text-gray-600" },
  running:   { label: "Running",   cls: "bg-amber-100 text-amber-700" },
  completed: { label: "Completed", cls: "bg-green-100 text-green-700" },
  failed:    { label: "Failed",    cls: "bg-red-100 text-red-700" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Produces a short human-readable summary of the task's input payload.
 * Displayed in the activity feed to give context without expanding the row.
 */
function summariseInput(
  agentName: AgentName,
  input: Record<string, unknown>
): string {
  // CEO: show the founder's prompt, truncated
  if (agentName === "ceo" && typeof input.prompt === "string") {
    const p = input.prompt.trim();
    return p.length > 90 ? p.slice(0, 90) + "…" : p;
  }

  // Company-scoped agents: prefer company name from nested object, fall back to UUID
  if (typeof input.companyId === "string") {
    const company = input.company as Record<string, unknown> | undefined;
    const name = typeof company?.name === "string" ? company.name : null;
    return name ? `Company: ${name}` : `Company: ${input.companyId.slice(0, 8)}…`;
  }

  // Master agent: show action from CEO output
  if (agentName === "master") {
    const ceoOut = input.ceoOutput as Record<string, unknown> | undefined;
    if (typeof ceoOut?.action === "string") return `Action: ${ceoOut.action}`;
  }

  // Sourcing: show sector filter
  if (agentName === "sourcing" && typeof input.sector === "string") {
    return `Sector: ${input.sector}`;
  }

  return `${agentName} task`;
}

/** Formats a duration in milliseconds as "Xm Ys" or "Xs". */
function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

/** Formats an ISO string as a short local time "HH:MM:SS". */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Computes a human-readable elapsed/duration string for a task.
 * - queued:    "Xm ago" (since created)
 * - running:   "Xm Ys elapsed" (since started)
 * - completed/failed: "Xm Ys" (total duration)
 */
function getElapsed(task: AgentTask, now: number): string {
  if (task.status === "queued") {
    return formatDuration(now - new Date(task.created_at).getTime()) + " ago";
  }
  if (task.status === "running" && task.started_at) {
    return formatDuration(now - new Date(task.started_at).getTime()) + " elapsed";
  }
  if (
    (task.status === "completed" || task.status === "failed") &&
    task.started_at &&
    task.completed_at
  ) {
    return formatDuration(
      new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
    );
  }
  return "—";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </p>
      <p className={`mt-2 text-3xl font-bold ${accent ?? "text-gray-900"}`}>
        {value}
      </p>
    </div>
  );
}

function AgentBadge({ name }: { name: AgentName }) {
  const cls = AGENT_BADGE[name] ?? "bg-gray-100 text-gray-600";
  return (
    <span
      className={`inline-flex shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${cls}`}
    >
      {name}
    </span>
  );
}

function StatusBadge({ status }: { status: AgentTaskStatus }) {
  const { label, cls } = STATUS_BADGE[status] ?? STATUS_BADGE.queued;
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

// ─── Task row ─────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: AgentTask;
  now: number;
  retryingIds: Set<string>;
  onRetry: (taskId: string) => void;
}

function TaskRow({ task, now, retryingIds, onRetry }: TaskRowProps) {
  const isRetrying = retryingIds.has(task.id);
  const summary = summariseInput(
    task.agent_name as AgentName,
    task.input
  );
  const elapsed = getElapsed(task, now);

  return (
    <div className="flex items-start gap-3 px-5 py-4 hover:bg-gray-50 transition-colors">
      {/* Running pulse dot */}
      <div className="mt-0.5 flex shrink-0 items-center justify-center w-4">
        {task.status === "running" ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          </span>
        ) : task.status === "failed" ? (
          <span className="h-2 w-2 rounded-full bg-red-400" />
        ) : task.status === "completed" ? (
          <span className="h-2 w-2 rounded-full bg-green-400" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-gray-300" />
        )}
      </div>

      {/* Badges */}
      <div className="flex shrink-0 flex-wrap gap-1.5 pt-px">
        <AgentBadge name={task.agent_name as AgentName} />
        <StatusBadge status={task.status} />
      </div>

      {/* Input summary + error */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-gray-800">{summary}</p>
        {task.status === "failed" && task.error && (
          <p className="mt-0.5 truncate text-xs text-red-500">{task.error}</p>
        )}
      </div>

      {/* Timing */}
      <div className="shrink-0 text-right">
        <p className="text-xs tabular-nums text-gray-500">{elapsed}</p>
        <p className="mt-0.5 text-xs tabular-nums text-gray-300">
          {formatTime(task.created_at)}
        </p>
      </div>

      {/* Retry */}
      {task.status === "failed" && (
        <button
          onClick={() => onRetry(task.id)}
          disabled={isRetrying}
          className="shrink-0 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
        >
          {isRetrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface AgentMonitorProps {
  initialData: TasksResponse;
}

export function AgentMonitor({ initialData }: AgentMonitorProps) {
  const [tasks, setTasks] = useState<AgentTask[]>(initialData.tasks);
  const [summary, setSummary] = useState<TasksSummary>(initialData.summary);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [polling, setPolling] = useState(false);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  // now is recomputed on each render to keep elapsed times current
  const now = Date.now();

  // ── Polling ────────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setPolling(true);
    try {
      const res = await fetch("/api/agents/tasks");
      if (!res.ok) return;
      const data: TasksResponse = await res.json();
      setTasks(data.tasks);
      setSummary(data.summary);
      setLastRefreshed(new Date());
    } catch {
      // silently ignore — next poll will retry
    } finally {
      setPolling(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  // ── Retry ──────────────────────────────────────────────────────────────────
  const handleRetry = useCallback(
    async (taskId: string) => {
      setRetryingIds((prev) => new Set(prev).add(taskId));
      try {
        const res = await fetch(`/api/agents/${taskId}/retry`, {
          method: "POST",
        });
        if (res.ok) {
          // Refresh immediately so the new queued task appears
          await refresh();
        }
      } catch {
        // silently ignore — user can try again
      } finally {
        setRetryingIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [refresh]
  );

  // ──────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agent Monitor</h1>
          <p className="mt-1 text-sm text-gray-500">
            Live view of all agent tasks. Auto-refreshes every 10 seconds.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          {polling && (
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-gray-400" />
          )}
          <span>
            Updated {lastRefreshed.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard label="Tasks Today" value={summary.todayTotal} />
        <SummaryCard
          label="Running Now"
          value={summary.running}
          accent={
            summary.running > 0 ? "text-amber-600" : "text-gray-900"
          }
        />
        <SummaryCard
          label="Completed"
          value={summary.completed}
          accent="text-green-600"
        />
        <SummaryCard
          label="Failed"
          value={summary.failed}
          accent={summary.failed > 0 ? "text-red-600" : "text-gray-900"}
        />
      </div>

      {/* Activity feed */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
          Activity Feed
        </h2>

        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
                <svg
                  className="h-6 w-6 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                  />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-600">
                No agent activity yet.
              </p>
              <p className="mt-1 text-sm text-gray-400">
                Send a prompt from the Deal Pipeline to get started.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  now={now}
                  retryingIds={retryingIds}
                  onRetry={handleRetry}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
