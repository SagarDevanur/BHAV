"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import type { Company, Contact, AgentResult, CompanyStatus } from "@/types/database";
import { CompanySidePanel } from "./company-side-panel";

// ─── Constants ────────────────────────────────────────────────────────────────

const SECTORS = ["All", "Physical AI", "Drones & UAV", "FinTech", "Autonomous EVs"] as const;
const PAGE_SIZE = 50;

const STATUS_CONFIG: Record<CompanyStatus, { label: string; bg: string; text: string }> = {
  sourced:  { label: "Sourced",  bg: "bg-slate-100",    text: "text-slate-600" },
  scoring:  { label: "Scoring",  bg: "bg-blue-50",      text: "text-blue-700" },
  reviewed: { label: "Reviewed", bg: "bg-amber-50",     text: "text-amber-700" },
  approved: { label: "Approved", bg: "bg-emerald-50",   text: "text-emerald-700" },
  rejected: { label: "Rejected", bg: "bg-red-50",       text: "text-red-700" },
  loi_sent: { label: "LOI Sent", bg: "bg-purple-50",    text: "text-purple-700" },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompanyWithContacts extends Company {
  contacts: Contact[];
}

interface CompaniesViewProps {
  initialCompanies: CompanyWithContacts[];
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const barColor  = score >= 70 ? "bg-emerald-500" : score >= 40 ? "bg-amber-500" : "bg-red-500";
  const textColor = score >= 70 ? "text-emerald-700" : score >= 40 ? "text-amber-700" : "text-red-700";

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full bg-slate-100">
        <div
          className={`h-1.5 rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className={`w-7 shrink-0 text-xs font-bold tabular-nums ${textColor}`}>
        {score}
      </span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CompaniesView({ initialCompanies }: CompaniesViewProps) {
  const [companies, setCompanies]       = useState<CompanyWithContacts[]>(initialCompanies);
  const [searchQuery, setSearchQuery]   = useState("");
  const [sectorFilter, setSectorFilter] = useState<string>("All");
  const [currentPage, setCurrentPage]   = useState(1);
  const [selectedCompany, setSelectedCompany] = useState<CompanyWithContacts | null>(null);
  const [agentResults, setAgentResults] = useState<AgentResult[]>([]);
  const [loadingResults, setLoadingResults] = useState(false);
  const [updatingIds, setUpdatingIds]   = useState<Set<string>>(new Set());

  // ── Fetch agent results when side panel opens ─────────────────────────────
  useEffect(() => {
    if (!selectedCompany) {
      setAgentResults([]);
      return;
    }
    async function fetch_() {
      if (!selectedCompany) return;
      setLoadingResults(true);
      try {
        const res = await fetch(`/api/companies/${selectedCompany.id}`);
        if (!res.ok) throw new Error("Failed");
        setAgentResults(await res.json() as AgentResult[]);
      } catch {
        setAgentResults([]);
      } finally {
        setLoadingResults(false);
      }
    }
    fetch_();
  }, [selectedCompany?.id]);

  // ── Filter + search ───────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return companies.filter((c) => {
      const matchSector = sectorFilter === "All" || c.sector === sectorFilter;
      const matchSearch = q === "" || c.name.toLowerCase().includes(q);
      return matchSector && matchSearch;
    });
  }, [companies, sectorFilter, searchQuery]);

  useEffect(() => { setCurrentPage(1); }, [searchQuery, sectorFilter]);

  // ── Pagination ────────────────────────────────────────────────────────────
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageStart  = (currentPage - 1) * PAGE_SIZE;
  const paginated  = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // ── Status update ─────────────────────────────────────────────────────────
  const handleStatusUpdate = useCallback(async (companyId: string, status: CompanyStatus) => {
    setUpdatingIds((prev) => new Set(prev).add(companyId));
    try {
      const res = await fetch(`/api/companies/${companyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Update failed");
      setCompanies((prev) => prev.map((c) => (c.id === companyId ? { ...c, status } : c)));
      setSelectedCompany((prev) => prev?.id === companyId ? { ...prev, status } : prev);
    } catch (err) {
      console.error("Failed to update status:", err);
    } finally {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(companyId);
        return next;
      });
    }
  }, []);

  function getDecisionMaker(company: CompanyWithContacts): string {
    if (!company.contacts?.length) return "—";
    const senior = company.contacts.find((c) => c.title?.match(/CEO|CFO|CTO|COO|President|Founder/i));
    return (senior ?? company.contacts[0]).name ?? "—";
  }

  const scoredCount   = filtered.filter((c) => c.despac_score !== null).length;
  const approvedCount = filtered.filter((c) => c.status === "approved" || c.status === "loi_sent").length;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Companies</h1>
        <p className="mt-1 text-sm text-slate-500">
          {totalCount} {totalCount === 1 ? "company" : "companies"}
          {scoredCount > 0 && ` · ${scoredCount} scored`}
          {approvedCount > 0 && ` · ${approvedCount} approved`}
        </p>
      </div>

      {/* ── Filters row ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Sector pills */}
        <div className="flex flex-wrap gap-1.5">
          {SECTORS.map((sector) => (
            <button
              key={sector}
              onClick={() => setSectorFilter(sector)}
              className={[
                "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                sectorFilter === sector
                  ? "bg-blue-700 text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900",
              ].join(" ")}
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
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 sm:w-64"
        />
      </div>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {paginated.length === 0 ? (
          <div className="flex h-64 items-center justify-center">
            <p className="text-sm text-slate-400">No companies match your filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    Company
                  </th>
                  <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    Sector
                  </th>
                  <th className="hidden px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400 lg:table-cell">
                    Decision Maker
                  </th>
                  <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    deSPAC Score
                  </th>
                  <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginated.map((company, idx) => {
                  const isUpdating = updatingIds.has(company.id);
                  const { label, bg, text } = STATUS_CONFIG[company.status];
                  const isSelected = selectedCompany?.id === company.id;

                  return (
                    <tr
                      key={company.id}
                      onClick={() => setSelectedCompany(company)}
                      className={[
                        "cursor-pointer transition-colors",
                        isSelected
                          ? "bg-blue-50"
                          : idx % 2 === 0
                          ? "bg-white hover:bg-slate-50"
                          : "bg-slate-50/70 hover:bg-slate-100/70",
                      ].join(" ")}
                    >
                      {/* Name + website */}
                      <td className="px-5 py-3.5">
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900">{company.name}</p>
                          {company.website && (
                            <p className="max-w-[180px] truncate text-[11px] text-slate-400">
                              {company.website}
                            </p>
                          )}
                        </div>
                      </td>

                      {/* Sector */}
                      <td className="px-4 py-3.5">
                        <div>
                          <p className="text-slate-700">{company.sector ?? "—"}</p>
                          {company.sub_sector && (
                            <p className="text-[11px] text-slate-400">{company.sub_sector}</p>
                          )}
                        </div>
                      </td>

                      {/* Decision maker */}
                      <td className="hidden px-4 py-3.5 text-slate-500 lg:table-cell">
                        {getDecisionMaker(company)}
                      </td>

                      {/* Score bar */}
                      <td className="px-4 py-3.5">
                        {company.despac_score !== null ? (
                          <ScoreBar score={company.despac_score} />
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Status badge */}
                      <td className="px-4 py-3.5">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${bg} ${text}`}
                        >
                          {label}
                        </span>
                      </td>

                      {/* Actions */}
                      <td
                        className="px-4 py-3.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => handleStatusUpdate(company.id, "approved")}
                            disabled={isUpdating || company.status === "approved"}
                            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition-all hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => handleStatusUpdate(company.id, "rejected")}
                            disabled={isUpdating || company.status === "rejected"}
                            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition-all hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-30"
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

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, totalCount)} of {totalCount}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-slate-600 shadow-sm hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            >
              Previous
            </button>
            <span className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-mono text-slate-500 tabular-nums shadow-sm">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-slate-600 shadow-sm hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* ── Side panel ───────────────────────────────────────────────────── */}
      {selectedCompany && (
        <CompanySidePanel
          company={selectedCompany}
          agentResults={agentResults}
          loadingResults={loadingResults}
          isUpdating={updatingIds.has(selectedCompany.id)}
          onClose={() => setSelectedCompany(null)}
          onStatusChange={(status) => handleStatusUpdate(selectedCompany.id, status)}
        />
      )}
    </div>
  );
}
