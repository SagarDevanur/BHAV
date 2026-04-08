// Database types — mirror the Supabase schema exactly.
// Column names are snake_case to match DB columns.
// All nullable DB columns are typed as `T | null`.
import type { AgentName } from "./agents";

// ------------------------------------------------------------------
// Enums / union types matching SQL CHECK constraints
// ------------------------------------------------------------------

export type CompanyStatus =
  | "sourced"
  | "scoring"
  | "reviewed"
  | "approved"
  | "rejected"
  | "loi_sent";

export type DealStage =
  | "sourced"
  | "scored"
  | "loi"
  | "diligence"
  | "pipe"
  | "announced";

export type AgentTaskStatus = "queued" | "running" | "completed" | "failed";

export type AgentResultType =
  | "score"
  | "contact"
  | "loi_draft"
  | "outreach_email"
  | "sec_draft"
  | "narrative";

// ------------------------------------------------------------------
// Row interfaces — one field per DB column, in schema order
// ------------------------------------------------------------------

export interface Company {
  id: string;
  name: string;
  website: string | null;
  sector: string | null;
  sub_sector: string | null;
  blurb: string | null;
  last_round: string | null;
  estimated_valuation: string | null;
  despac_score: number | null;
  status: CompanyStatus;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  company_id: string | null; // nullable in schema — no NOT NULL constraint
  name: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  phone: string | null;
  enriched_at: string | null;
  created_at: string;
}

export interface AgentTask {
  id: string;
  agent_name: AgentName;
  status: AgentTaskStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AgentResult {
  id: string;
  task_id: string | null; // nullable: ON DELETE CASCADE may orphan briefly
  company_id: string | null;
  agent_name: AgentName;
  result_type: AgentResultType;
  content: Record<string, unknown>;
  created_at: string;
}

export interface DealPipeline {
  id: string;
  company_id: string | null; // nullable: UNIQUE but no NOT NULL in schema
  stage: DealStage;
  despac_score: number | null;
  approved_by: string | null;
  notes: string | null;
  updated_at: string;
}

// ------------------------------------------------------------------
// Insert types — omit server-generated fields
// ------------------------------------------------------------------

export type InsertCompany = Omit<Company, "id" | "created_at" | "updated_at">;

export type InsertContact = Omit<Contact, "id" | "created_at">;

/** Status defaults to "queued"; started_at/completed_at/output/error are set by the worker */
export type InsertAgentTask = Omit<
  AgentTask,
  "id" | "created_at" | "started_at" | "completed_at" | "output" | "error"
>;

export type InsertAgentResult = Omit<AgentResult, "id" | "created_at">;

export type InsertDealPipeline = Omit<DealPipeline, "id" | "updated_at">;

// ------------------------------------------------------------------
// Update types — all fields optional except the primary key
// ------------------------------------------------------------------

export type UpdateCompany = Partial<Omit<Company, "id" | "created_at">>;

export type UpdateContact = Partial<Omit<Contact, "id" | "created_at">>;

export type UpdateAgentTask = Partial<
  Omit<AgentTask, "id" | "created_at" | "agent_name" | "input">
>;

export type UpdateDealPipeline = Partial<Omit<DealPipeline, "id">>;
