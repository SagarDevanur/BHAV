"use client";

import { useEffect, useState } from "react";

interface StatusResponse {
  running: boolean;
  count: number;
}

export function AgentStatusIndicator() {
  const [status, setStatus] = useState<StatusResponse>({ running: false, count: 0 });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/agents/status");
        if (res.ok && !cancelled) {
          const data = (await res.json()) as StatusResponse;
          setStatus(data);
        }
      } catch {
        // Network error — keep last known state
      }
    }

    void poll();
    const id = setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex items-center gap-2">
      {/* Dot */}
      <span className="relative flex h-2 w-2">
        {status.running && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
        )}
        <span
          className={[
            "relative inline-flex h-2 w-2 rounded-full",
            status.running
              ? "bg-green-500"
              : "bg-gray-300 dark:bg-gray-600",
          ].join(" ")}
        />
      </span>

      {/* Label */}
      <span
        className={[
          "text-xs font-medium",
          status.running
            ? "text-green-600 dark:text-green-400"
            : "text-gray-400 dark:text-gray-500",
        ].join(" ")}
      >
        {status.running
          ? `${status.count} agent${status.count !== 1 ? "s" : ""} running`
          : "Agents idle"}
      </span>
    </div>
  );
}
