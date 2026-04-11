"use client";

import type { AgentResult, CompanyStatus } from "@/types/database";
import type { CompanyWithContacts } from "./companies-view";

interface CompanySidePanelProps {
  company: CompanyWithContacts;
  agentResults: AgentResult[];
  loadingResults: boolean;
  isUpdating: boolean;
  onClose: () => void;
  onStatusChange: (status: CompanyStatus) => void;
}

const RESULT_TYPE_LABELS: Record<string, string> = {
  score: "Score",
  contact: "Contact Enrichment",
  loi_draft: "LOI Draft",
  outreach_email: "Outreach Email",
  sec_draft: "SEC Draft",
  narrative: "Narrative",
};

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

export function CompanySidePanel({
  company,
  agentResults,
  loadingResults,
  isUpdating,
  onClose,
  onStatusChange,
}: CompanySidePanelProps) {
  const { label: statusLabel, pillClass } = STATUS_CONFIG[company.status];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <aside className="fixed inset-y-0 right-0 z-50 flex w-[480px] flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-100 px-6 py-5">
          <div className="min-w-0 pr-4">
            <h2 className="truncate text-lg font-semibold text-gray-900">
              {company.name}
            </h2>
            {company.website && (
              <a
                href={company.website}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-sm text-blue-600 hover:underline truncate block"
              >
                {company.website}
              </a>
            )}
            <span
              className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pillClass}`}
            >
              {statusLabel}
            </span>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            aria-label="Close panel"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Company details */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
              Company Details
            </h3>
            <dl className="space-y-2.5">
              <DetailRow label="Sector" value={company.sector} />
              <DetailRow label="Sub-sector" value={company.sub_sector} />
              <DetailRow label="Last Round" value={company.last_round} />
              <DetailRow
                label="Est. Valuation"
                value={company.estimated_valuation}
              />
              <DetailRow
                label="deSPAC Score"
                value={
                  company.despac_score !== null
                    ? String(company.despac_score)
                    : null
                }
              />
            </dl>
          </section>

          {/* Blurb */}
          {company.blurb && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                About
              </h3>
              <p className="text-sm text-gray-700 leading-relaxed">
                {company.blurb}
              </p>
            </section>
          )}

          {/* Contacts */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
              Contacts{" "}
              {company.contacts.length > 0 && (
                <span className="normal-case font-normal text-gray-400">
                  ({company.contacts.length})
                </span>
              )}
            </h3>
            {company.contacts.length === 0 ? (
              <p className="text-sm text-gray-400">No contacts yet.</p>
            ) : (
              <ul className="space-y-3">
                {company.contacts.map((contact) => (
                  <li
                    key={contact.id}
                    className="rounded-lg border border-gray-100 bg-gray-50 p-3"
                  >
                    <div className="font-medium text-sm text-gray-900">
                      {contact.name ?? "—"}
                    </div>
                    {contact.title && (
                      <div className="text-xs text-gray-500 mt-0.5">
                        {contact.title}
                      </div>
                    )}
                    <div className="mt-2 space-y-1">
                      {contact.email && (
                        <ContactRow icon="✉" label={contact.email} />
                      )}
                      {contact.phone && (
                        <ContactRow icon="☎" label={contact.phone} />
                      )}
                      {contact.linkedin_url && (
                        <a
                          href={contact.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline"
                        >
                          <span>in</span>
                          <span>LinkedIn</span>
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Agent Results */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
              Agent Results{" "}
              {agentResults.length > 0 && (
                <span className="normal-case font-normal text-gray-400">
                  ({agentResults.length})
                </span>
              )}
            </h3>
            {loadingResults ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : agentResults.length === 0 ? (
              <p className="text-sm text-gray-400">No agent results yet.</p>
            ) : (
              <ul className="space-y-3">
                {agentResults.map((result) => (
                  <li
                    key={result.id}
                    className="rounded-lg border border-gray-100 bg-gray-50 p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-gray-700">
                        {RESULT_TYPE_LABELS[result.result_type] ??
                          result.result_type}
                      </span>
                      <span className="text-xs text-gray-400">
                        {result.agent_name}
                      </span>
                    </div>
                    <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono bg-white rounded border border-gray-100 p-2">
                      {JSON.stringify(result.content, null, 2)}
                    </pre>
                    <div className="mt-1.5 text-xs text-gray-300">
                      {new Date(result.created_at).toLocaleString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Footer — approve / reject */}
        <div className="border-t border-gray-100 px-6 py-4 flex gap-3">
          <button
            onClick={() => onStatusChange("approved")}
            disabled={isUpdating || company.status === "approved"}
            className="flex-1 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Approve
          </button>
          <button
            onClick={() => onStatusChange("rejected")}
            disabled={isUpdating || company.status === "rejected"}
            className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Reject
          </button>
        </div>
      </aside>
    </>
  );
}

// Helper sub-components

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <dt className="w-32 shrink-0 text-gray-400">{label}</dt>
      <dd className="text-gray-800">{value ?? "—"}</dd>
    </div>
  );
}

function ContactRow({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-600">
      <span className="text-gray-300">{icon}</span>
      <span>{label}</span>
    </div>
  );
}
