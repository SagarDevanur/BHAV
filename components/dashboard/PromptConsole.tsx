"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// ---------------------------------------------------------------------------
// Types — mirror CeoRunResult from lib/agents/ceo-agent.ts
// ---------------------------------------------------------------------------

interface DispatchedJob {
  agentName: string;
  taskId: string;
  bullJobId: string;
}

interface CeoResult {
  ceoTaskId: string;
  summary: string;
  taskType: string;
  approvedByHuman: boolean;
  modelUsed: string;
  dispatchedJobs: DispatchedJob[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  "Score all Physical AI companies",
  "Find 20 FinTech targets under $200M",
  "Enrich contacts for top 50 targets",
] as const;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PromptConsole() {
  const [prompt, setPrompt]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [result, setResult]   = useState<CeoResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmed  = prompt.trim();
  const canSubmit = trimmed.length > 0 && !loading;

  async function submit() {
    if (!canSubmit) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/agents/ceo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmed }),
      });

      const data = (await res.json()) as CeoResult & { error?: string };

      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      setResult(data);
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  }

  function fillSuggestion(text: string) {
    setPrompt(text);
    textareaRef.current?.focus();
  }

  return (
    <div className="space-y-3">
      {/* ── Input card ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
          CEO Agent — Instruction Console
        </p>

        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={loading}
          placeholder={`Type an instruction in plain English…\n\nExamples: "Find 10 drone companies under $100M" or "Score all unscored Physical AI targets"`}
          className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 placeholder-slate-400 transition-colors focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={loading}
              onClick={() => fillSuggestion(s)}
              className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600 transition-colors hover:border-slate-300 hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {s}
            </button>
          ))}

          <span className="ml-auto hidden text-xs text-slate-300 sm:block">
            ⌘ Enter to send
          </span>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (
              <>
                <Spinner />
                Processing…
              </>
            ) : (
              <>
                Send
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Loading state ──────────────────────────────────────────────── */}
      {loading && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
          <Spinner className="h-4 w-4 text-amber-600" />
          <div>
            <p className="text-sm font-medium text-amber-700">
              CEO agent is interpreting your instruction
            </p>
            <p className="mt-0.5 text-xs text-amber-600/70">
              Routing to the master agent and queuing sub-agent jobs…
            </p>
          </div>
        </div>
      )}

      {/* ── Error state ────────────────────────────────────────────────── */}
      {error && !loading && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-4">
          <svg
            className="mt-0.5 h-4 w-4 shrink-0 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-red-700">Dispatch failed</p>
            <p className="mt-0.5 text-xs text-red-600">{error}</p>
          </div>
        </div>
      )}

      {/* ── Result state ───────────────────────────────────────────────── */}
      {result && !loading && (
        <div className="overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-sm">
          {/* Result header */}
          <div className="border-b border-emerald-100 bg-emerald-50 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <svg
                className="h-4 w-4 text-emerald-600"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm font-semibold text-emerald-700">
                {result.dispatchedJobs.length} job{result.dispatchedJobs.length !== 1 ? "s" : ""} dispatched
              </span>
              <span className="ml-auto text-xs capitalize text-emerald-600/70">
                {result.taskType.replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-slate-600">
              <span className="font-medium text-slate-400">Understood: </span>
              {result.summary}
            </p>
          </div>

          {/* Job rows */}
          <ul className="divide-y divide-slate-100">
            {result.dispatchedJobs.map((job, i) => (
              <li key={job.taskId} className="flex items-center gap-3 px-5 py-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium capitalize text-slate-900">
                    {job.agentName} agent
                  </span>
                  <span className="ml-2 font-mono text-xs text-slate-400">
                    {job.taskId.slice(0, 8)}…
                  </span>
                </div>
                <span className="shrink-0 inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  queued
                </span>
              </li>
            ))}
          </ul>

          {/* Footer */}
          <div className="flex items-center gap-3 border-t border-slate-100 bg-slate-50 px-5 py-2.5">
            <span className="text-xs text-slate-400">
              CEO task <span className="font-mono">{result.ceoTaskId.slice(0, 8)}…</span>
            </span>
            <span className="text-slate-200">·</span>
            <span className="text-xs text-slate-400">
              via {result.modelUsed.startsWith("claude") ? "Claude" : "OpenAI (fallback)"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
