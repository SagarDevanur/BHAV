"use client";

import { useEffect, useState, useCallback } from "react";

interface PendingUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  createdAt: number;
}

export function PendingUsersPanel() {
  const [users, setUsers]     = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState<string | null>(null);
  const [error, setError]     = useState("");

  const fetchPending = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/pending-users");
      if (!res.ok) throw new Error("Failed to load pending users");
      const data = (await res.json()) as { users: PendingUser[] };
      setUsers(data.users);
    } catch {
      setError("Could not load pending users. Please refresh.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  const handleApprove = async (userId: string) => {
    setApproving(userId);
    setError("");
    try {
      const res = await fetch("/api/approve-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error("Failed to approve user");
      // Remove from list
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch {
      setError("Could not approve user. Please try again.");
    } finally {
      setApproving(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <p className="text-sm text-slate-400">Loading pending requests…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (users.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 border border-emerald-100">
          <svg className="h-5 w-5 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <p className="text-sm font-medium text-slate-700">No pending requests</p>
        <p className="mt-1 text-xs text-slate-400">All access requests have been reviewed.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
      {users.map((user) => (
        <div
          key={user.id}
          className="flex items-center justify-between gap-4 px-5 py-4"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900 truncate">
              {user.firstName} {user.lastName}
            </p>
            <p className="text-xs text-slate-500 truncate">{user.email}</p>
          </div>

          <button
            onClick={() => void handleApprove(user.id)}
            disabled={approving === user.id}
            className="shrink-0 rounded-lg bg-blue-900 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-800 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {approving === user.id ? "Approving…" : "Approve"}
          </button>
        </div>
      ))}
    </div>
  );
}
