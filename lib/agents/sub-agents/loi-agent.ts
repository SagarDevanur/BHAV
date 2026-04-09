/**
 * LOI Agent — drafts Letters of Intent for approved deSPAC acquisition targets.
 *
 * HUMAN APPROVAL GATE:
 *   - approvedByHuman: false → LOI is drafted and saved, company status unchanged
 *   - approvedByHuman: true  → LOI is drafted, company status set to "loi_sent"
 *
 * The LOI is never transmitted by this agent. "loi_sent" means the draft has
 * been approved for sending by a co-founder; actual sending is a manual action.
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Writes agent_results row with result_type = "loi_draft"
 *   - Updates companies.status to "loi_sent" only when approvedByHuman: true
 *
 * Input:  AgentInput — companyId at top level, deal terms in payload
 * Output: LoiRunResult
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

// ---------------------------------------------------------------------------
// LLM clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

let _openai: OpenAI | null = null;
function getOpenAiClient(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error("OpenAI fallback unavailable: OPENAI_API_KEY is not set.");
  }
  if (!_openai) _openai = new OpenAI({ apiKey: config.openai.apiKey });
  return _openai;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BHAV_SPAC_NAME = "BHAV Acquisition Corp";
const DEFAULT_EXCLUSIVITY_DAYS = 45;
const DEFAULT_DEAL_STRUCTURE   = "deSPAC merger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoiDealParameters {
  /** Proposed enterprise value, e.g. "$120M–$150M". */
  proposedValuation: string;
  /** Deal structure, e.g. "deSPAC merger". */
  structure: string;
  /** SPAC entity name. */
  spac_name: string;
  /** Exclusivity window in days. */
  exclusivityPeriodDays: number;
  /** Key economic / structural terms. */
  keyTerms: string[];
}

export interface LoiRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  /** Full LOI text in markdown — ready for dashboard display. */
  loi_draft: string;
  /** One-paragraph summary of key terms. */
  summary: string;
  /** Always true — LOI must be co-founder-reviewed before sending. */
  reviewRequired: true;
  /** Flags raised by Claude (unusual terms, missing data, etc.). */
  warnings: string[];
  /** Whether company status was advanced to "loi_sent". */
  statusAdvanced: boolean;
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Raw LLM response — validated before use. */
interface LlmLoiResponse {
  companyId: string;
  loi_draft: string;
  summary: string;
  reviewRequired: true;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateLlmResponse(raw: unknown, fallbackId: string): LlmLoiResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("LOI agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  const loiDraft = String(r.loi_draft ?? "").trim();
  if (!loiDraft) {
    throw new Error("LOI agent returned an empty loi_draft");
  }

  return {
    companyId:      String(r.companyId ?? fallbackId),
    loi_draft:      loiDraft,
    summary:        String(r.summary ?? ""),
    reviewRequired: true, // always enforce — never trust LLM to set this
    warnings:       Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface CompanyRow {
  id: string;
  name: string;
  sector: string | null;
  sub_sector: string | null;
  blurb: string | null;
  estimated_valuation: string | null;
  last_round: string | null;
  despac_score: number | null;
  status: string;
}

interface ContactRow {
  name: string | null;
  title: string | null;
}

/** Seniority order for picking the primary contact to address the LOI to. */
const TITLE_PRIORITY = [
  /\bCEO\b/i,
  /\bFounder\b/i,
  /\bPresident\b/i,
  /\bCOO\b/i,
  /\bCFO\b/i,
  /\bCTO\b/i,
];

function rankContact(contact: ContactRow): number {
  const title = contact.title ?? "";
  for (let i = 0; i < TITLE_PRIORITY.length; i++) {
    if (TITLE_PRIORITY[i].test(title)) return i;
  }
  return TITLE_PRIORITY.length; // lowest priority
}

async function fetchCompany(companyId: string): Promise<CompanyRow> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id, name, sector, sub_sector, blurb, estimated_valuation, last_round, despac_score, status"
    )
    .eq("id", companyId)
    .single();

  if (error || !data) {
    throw new Error(`Company ${companyId} not found: ${error?.message ?? "no row"}`);
  }

  return data as CompanyRow;
}

async function fetchPrimaryContact(companyId: string): Promise<ContactRow> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("contacts")
    .select("name, title")
    .eq("company_id", companyId);

  const contacts = (data ?? []) as ContactRow[];
  if (contacts.length === 0) {
    return { name: null, title: null };
  }

  // Pick the most senior contact by title
  return contacts.slice().sort((a, b) => rankContact(a) - rankContact(b))[0];
}

// ---------------------------------------------------------------------------
// Deal parameter defaults
// ---------------------------------------------------------------------------

/**
 * Merges caller-supplied deal terms with BHAV defaults.
 * Derives a proposed valuation range from the company's estimated_valuation
 * when the caller doesn't supply one.
 */
function buildDealParameters(
  company: CompanyRow,
  callerTerms: Record<string, unknown> | undefined
): LoiDealParameters {
  const terms = callerTerms ?? {};

  // Derive a sensible proposed valuation from the stored estimate if available
  let proposedValuation = String(terms.proposedValuation ?? "");
  if (!proposedValuation && company.estimated_valuation) {
    proposedValuation = `~${company.estimated_valuation} (subject to due diligence)`;
  }
  if (!proposedValuation) {
    proposedValuation = "[PROPOSED VALUATION — TO BE COMPLETED]";
  }

  const keyTerms: string[] = Array.isArray(terms.keyTerms)
    ? (terms.keyTerms as string[])
    : [
        "100% stock consideration at signing",
        "Subject to satisfactory financial due diligence",
        "Standard SPAC merger representations and warranties",
        "No-shop clause during exclusivity period",
        "PIPE financing contingency at co-founders' discretion",
      ];

  return {
    proposedValuation,
    structure:            String(terms.structure          ?? DEFAULT_DEAL_STRUCTURE),
    spac_name:            String(terms.spac_name          ?? BHAV_SPAC_NAME),
    exclusivityPeriodDays: Number(terms.exclusivityPeriodDays ?? DEFAULT_EXCLUSIVITY_DAYS),
    keyTerms,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(
  company: CompanyRow,
  primaryContact: ContactRow,
  dealParameters: LoiDealParameters,
  approvedByHuman: boolean
): Promise<{ parsed: LlmLoiResponse; modelUsed: string }> {
  const userMessage = JSON.stringify({
    companyId:           company.id,
    companyName:         company.name,
    sector:              company.sector,
    estimated_valuation: company.estimated_valuation,
    dealParameters,
    primaryContact: {
      name:  primaryContact.name  ?? "[Decision Maker Name]",
      title: primaryContact.title ?? "[Title]",
    },
    approvedByHuman,
  });

  let responseText: string;
  let modelUsed: string;

  try {
    const message = await anthropic.messages.create({
      model:      config.anthropic.model,
      max_tokens: 4096,
      system:     AGENT_PROMPTS.loi,
      messages:   [{ role: "user", content: userMessage }],
    });

    if (message.content[0].type !== "text") {
      throw new Error("Claude returned a non-text content block");
    }

    responseText = message.content[0].text;
    modelUsed    = config.anthropic.model;
  } catch (claudeErr) {
    console.error("[LOI agent] Anthropic API error:", claudeErr);
    if (!config.openai.apiKey) throw claudeErr;

    const claudeMessage =
      claudeErr instanceof Error ? claudeErr.message : String(claudeErr);

    const completion = await getOpenAiClient().chat.completions.create({
      model:           config.openai.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AGENT_PROMPTS.loi },
        { role: "user",   content: userMessage },
      ],
    });

    responseText = completion.choices[0]?.message?.content ?? "{}";
    modelUsed    = `${config.openai.model} (fallback — Claude error: ${claudeMessage})`;
  }

  let parsed: LlmLoiResponse;
  try {
    parsed = validateLlmResponse(JSON.parse(responseText), company.id);
  } catch {
    throw new Error(
      `LOI agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

async function saveLoiResult(
  taskId: string,
  companyId: string,
  parsed: LlmLoiResponse,
  dealParameters: LoiDealParameters,
  approvedByHuman: boolean,
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "loi",
    result_type: "loi_draft",
    content: {
      loi_draft:       parsed.loi_draft,
      summary:         parsed.summary,
      reviewRequired:  true,
      warnings:        parsed.warnings,
      dealParameters,
      approvedByHuman,
      modelUsed,
      draftedAt:       nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    throw new Error(`Failed to save LOI to agent_results: ${error.message}`);
  }
}

async function advanceCompanyStatus(companyId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("companies")
    .update({ status: "loi_sent", updated_at: nowIso() })
    .eq("id", companyId);

  if (error) {
    throw new Error(
      `Failed to advance company ${companyId} to loi_sent: ${error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the LOI agent to draft a Letter of Intent for an approved target.
 *
 * Flow:
 *   1. Enforce the human approval gate — mark failed and throw if not approved.
 *   2. Mark agent_tasks row as running.
 *   3. Fetch full company record and primary contact from Supabase.
 *   4. Build deal parameters (caller-supplied terms merged with BHAV defaults).
 *   5. Call Claude; fall back to OpenAI on failure.
 *   6. Validate LLM response — enforce reviewRequired: true regardless of LLM output.
 *   7. Save LOI draft to agent_results (result_type = "loi_draft").
 *   8. Advance company status to "loi_sent" if and only if approvedByHuman: true.
 *   9. Mark agent_tasks completed (or failed on any error).
 *  10. Return LoiRunResult including full loi_draft text.
 *
 * @param input - AgentInput; companyId at top level, optional terms in payload
 * @returns     LoiRunResult with full LOI markdown and metadata
 * @throws      If approvedByHuman is false/absent, or on LLM / DB errors
 */
export async function runLoiAgent(input: AgentInput): Promise<LoiRunResult> {
  const supabase    = createAdminClient();
  const companyId   = input.companyId ?? String((input.payload ?? {}).companyId ?? "");
  const approvedByHuman = input.approvedByHuman === true;

  if (!companyId) {
    throw new Error("LOI agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Human approval gate — must be checked BEFORE the task row is
  //    marked running so failures are clearly attributable to missing approval
  // ------------------------------------------------------------------
  if (!approvedByHuman) {
    const supabaseInner = createAdminClient();
    await supabaseInner
      .from("agent_tasks")
      .update({
        status:       "failed",
        error:        "LOI agent requires approvedByHuman: true. Set this flag to authorise drafting.",
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    throw new Error(
      "LOI agent requires approvedByHuman: true. " +
        "Ensure a co-founder has explicitly approved before dispatching the LOI agent."
    );
  }

  // ------------------------------------------------------------------
  // 2. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: nowIso() })
    .eq("id", input.taskId);

  try {
    // ------------------------------------------------------------------
    // 3. Fetch company + primary contact (parallel)
    // ------------------------------------------------------------------
    const [company, primaryContact] = await Promise.all([
      fetchCompany(companyId),
      fetchPrimaryContact(companyId),
    ]);

    // ------------------------------------------------------------------
    // 4. Build deal parameters
    // ------------------------------------------------------------------
    const callerTerms = (input.payload?.terms ?? {}) as Record<string, unknown>;
    const dealParameters = buildDealParameters(company, callerTerms);

    // ------------------------------------------------------------------
    // 5 + 6. Call LLM and validate response
    // ------------------------------------------------------------------
    const { parsed, modelUsed } = await callLlm(
      company,
      primaryContact,
      dealParameters,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 7. Save to agent_results
    // ------------------------------------------------------------------
    await saveLoiResult(
      input.taskId,
      companyId,
      parsed,
      dealParameters,
      approvedByHuman,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 8. Advance company status only when approved
    //    (approvedByHuman is guaranteed true here, but keep the guard
    //     explicit so future refactors can't accidentally skip it)
    // ------------------------------------------------------------------
    let statusAdvanced = false;
    if (approvedByHuman) {
      await advanceCompanyStatus(companyId);
      statusAdvanced = true;
    }

    // ------------------------------------------------------------------
    // 9. Mark task completed
    // ------------------------------------------------------------------
    const result: LoiRunResult = {
      taskId:         input.taskId,
      companyId,
      companyName:    company.name,
      loi_draft:      parsed.loi_draft,
      summary:        parsed.summary,
      reviewRequired: true,
      warnings:       parsed.warnings,
      statusAdvanced,
      approvedByHuman,
      modelUsed,
    };

    await supabase
      .from("agent_tasks")
      .update({
        status:       "completed",
        output:       result as unknown as Record<string, unknown>,
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    await supabase
      .from("agent_tasks")
      .update({ status: "failed", error, completed_at: nowIso() })
      .eq("id", input.taskId);

    throw err;
  }
}
