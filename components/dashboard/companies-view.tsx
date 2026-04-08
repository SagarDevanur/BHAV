"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import type {
  Company,
  Contact,
  AgentResult,
  CompanyStatus,
} from "@/types/database";
import { CompanySidePanel } from "./company-side-panel";

// ─── Constants ──────────────────────────────────────────────────────────────

const SECTORS = [
  "All",
  "Physical AI",
  "Drones & UAV",
  "FinTech",
  "Autonomous EVs",
] as const;

const PAGE_SIZE = 50;

const STATUS_CONFIG: Record<
  CompanyStatus,
  { label: string; pillClass: string }
> = {
  sourced: { label: "Sourced", pillClass: "bg-gray-100 text-gray-700" },
  scoring: { label: "Scoring", pillClass: "bg-blue-100 text-blue-700" },
  reviewed: { label: "Reviewed", pillClass: "bg-amber-100 text-amber-700" },
  approved: { label: "Approved", pillClass: "bg-green-100 text-green-700" },
  rejected: { label: "Rejected", pillClass: "bg-red-100 text-red-700" },
  loi_sent: { label: "LOI Sent", pillClass: "bg-purple-100 text-purple-700" },
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompanyWithContacts extends Company {
  contacts: Contact[];
}

interface CompaniesViewProps {
  initialCompanies: CompanyWithContacts[];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CompaniesView({ initialCompanies }: CompaniesViewProps) {
  const [companies, setCompanies] =
    useState<CompanyWithContacts[]>(initialCompanies);
  const [searchQuery, setSearchQuery] = useState("");
  const [sectorFilter, setSectorFilter] = useState<string>("All");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedCompany, setSelectedCompany] =
    useState<CompanyWithContacts | null>(null);
  const [agentResults, setAgentResults] = useState<AgentResult[]>([]);
  const [loadingResults, setLoadingResults] = useState(false);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());

  // ── Fetch agent results when side panel opens ────────────────────────────
  useEffect(() => {
    if (!selectedCompany) {
      setAgentResults([]);
      return;
    }

    async function fetchAgentResults() {
      if (!selectedCompany) return;
      setLoadingResults(true);
      try {
        const res = await fetch(`/api/companies/${selectedCompany.id}`);
        if (!res.ok) throw new Error("Failed to fetch agent results");
        const data: AgentResult[] = await res.json();
        setAgentResults(data);
      } catch (err) {
        console.error("Failed to fetch agent results:", err);
        setAgentResults([]);
      } finally {
        setLoadingResults(false);
      }
    }

    fetchAgentResults();
  }, [selectedCompany?.id]);

  // ── Filter + search (client-side) ────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return companies.filter((company) => {
      const matchesSector =
        sectorFilter === "All" || company.sector === sectorFilter;
      const matchesSearch = q === "" || company.name.toLowerCase().includes(q);
      return matchesSector && matchesSearch;
    });
  }, [companies, sectorFilter, searchQuery]);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sectorFilter]);

  // ── Pagination ───────────────────────────────────────────────────────────
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const paginated = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // ── Status update ────────────────────────────────────────────────────────
  const handleStatusUpdate = useCallback(
    async (companyId: string, status: CompanyStatus) => {
      setUpdatingIds((prev) => new Set(prev).add(companyId));

      try {
        const res = await fetch(`/api/companies/${companyId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });

        if (!res.ok) throw new Error("Update failed");

        setCompanies((prev) =>
          prev.map((c) => (c.id === companyId ? { ...c, status } : c))
        );
        setSelectedCompany((prev) =>
          prev?.id === companyId ? { ...prev, status } : prev
        );
      } catch (err) {
        console.error("Failed to update status:", err);
      } finally {
        setUpdatingIds((prev) => {
          const next = new Set(prev);
          next.delete(companyId);
          return next;
        });
      }
    },
    []
  );

  // ── Helpers ──────────────────────────────────────────────────────────────
  function getDecisionMaker(company: CompanyWithContacts): string {
    if (!company.contacts?.length) return "—";
    const senior = company.contacts.find((c) =>
      c.title?.match(/CEO|CFO|CTO|COO|President|Founder/i)
    );
    const contact = senior ?? company.contacts[0];
    return contact.name ?? "—";
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Companies</h1>
        <p className="mt-1 text-sm text-gray-500">
          {totalCount} {totalCount === 1 ? "company" : "companies"} found
        </p>
      </div>

      {/* Filters row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Sector pills */}
        <div className="flex flex-wrap gap-2">
          {SECTORS.map((sector) => (
            <button
              key={sector}
              onClick={() => setSectorFilter(sector)}
              className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                sectorFilter === sector
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 bg-white text-gray-600 hover:border-gray-400"
              }`}
            >
              {sector}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="search"
          placeholder="Search companies…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 sm:w-64"
        />
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        {paginated.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-sm text-gray-400">
            No companies match your filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Company
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Sector
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Sub-sector
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Decision Maker
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400">
                    deSPAC Score
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {paginated.map((company) => {
                  const isUpdating = updatingIds.has(company.id);
                  const { label, pillClass } = STATUS_CONFIG[company.status];

                  return (
                    <tr
                      key={company.id}
                      onClick={() => setSelectedCompany(company)}
                      className="cursor-pointer transition-colors hover:bg-gray-50"
                    >
                      {/* Name + website */}
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">
                          {company.name}
                        </div>
                        {company.website && (
                          <div className="max-w-[200px] truncate text-xs text-gray-400">
                            {company.website}
                          </div>
                        )}
                      </td>

                      {/* Sector */}
                      <td className="px-4 py-3 text-gray-600">
                        {company.sector ?? "—"}
                      </td>

                      {/* Sub-sector */}
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {company.sub_sector ?? "—"}
                      </td>

                      {/* Decision maker */}
                      <td className="px-4 py-3 text-gray-600">
                        {getDecisionMaker(company)}
                      </td>

                      {/* deSPAC score */}
                      <td className="px-4 py-3 text-center">
                        {company.despac_score !== null ? (
                          <ScorePill score={company.despac_score} />
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>

                      {/* Status badge */}
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pillClass}`}
                        >
                          {label}
                        </span>
                      </td>

                      {/* Approve / Reject — stop row click propagation */}
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() =>
                              handleStatusUpdate(company.id, "approved")
                            }
                            disabled={
                              isUpdating || company.status === "approved"
                            }
                            className="rounded px-2 py-1 text-xs font-medium bg-green-50 text-green-700 hover:bg-green-100 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() =>
                              handleStatusUpdate(company.id, "rejected")
                            }
                            disabled={
                              isUpdating || company.status === "rejected"
                            }
                            className="rounded px-2 py-1 text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>
            Showing {pageStart + 1}–
            {Math.min(pageStart + PAGE_SIZE, totalCount)} of {totalCount}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
            >
              Previous
            </button>
            <span className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 tabular-nums">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() =>
                setCurrentPage((p) => Math.min(totalPages, p + 1))
              }
              disabled={currentPage === totalPages}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Side panel */}
      {selectedCompany && (
        <CompanySidePanel
          company={selectedCompany}
          agentResults={agentResults}
          loadingResults={loadingResults}
          isUpdating={updatingIds.has(selectedCompany.id)}
          onClose={() => setSelectedCompany(null)}
          onStatusChange={(status) =>
            handleStatusUpdate(selectedCompany.id, status)
          }
        />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScorePill({ score }: { score: number }) {
  const colorClass =
    score >= 75
      ? "text-green-700 bg-green-50"
      : score >= 50
        ? "text-amber-700 bg-amber-50"
        : "text-gray-600 bg-gray-100";

  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${colorClass}`}
    >
      {score}
    </span>
  );
}
