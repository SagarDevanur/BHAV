/**
 * Outreach Agent — drafts a personalised initial PIPE outreach email plus a
 * two-email follow-up sequence for approved deSPAC acquisition targets.
 *
 * HUMAN APPROVAL GATE:
 *   - approvedByHuman: false → task is marked failed immediately; no drafts produced
 *   - approvedByHuman: true  → all three email drafts are written to agent_results
 *
 * Emails are NEVER sent by this agent. The drafts are surfaced in the dashboard
 * for co-founder review and manual dispatch.
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Writes agent_results row with result_type = "outreach_email"
 *
 * Input:  AgentInput — companyId at top level, optional outreach context in payload
 * Output: OutreachRunResult
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

// ---------------------------------------------------------------------------
// LLM clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SENDER_NAME = "BHAV Acquisition Corp";
const DEFAULT_ANGLE       = "strategic acquisition interest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutreachEmail {
  /** Position in the send sequence. */
  sequence: "initial" | "follow_up_1" | "follow_up_2";
  /** Recipient email address — null when contact has no known email. */
  to: string | null;
  toName: string;
  subject: string;
  /** Plain-text email body. */
  body: string;
  /** Always true — every draft requires co-founder sign-off before sending. */
  reviewRequired: true;
}

export interface OutreachContext {
  /** Co-founder name that will appear as sender. */
  senderName: string;
  /** Outreach angle, e.g. "acquisition interest", "strategic partnership". */
  angle: string;
  /** Any personalisation notes to incorporate. */
  personalisation: string | null;
}

export interface OutreachRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  /** All three drafted emails — initial + two follow-ups. */
  emails: OutreachEmail[];
  /** Short paragraph summarising the outreach strategy. */
  outreachSummary: string;
  /** Number of contacts found for this company. */
  contactsTargeted: number;
  /** Always true — drafts must be reviewed before any email is sent. */
  reviewRequired: true;
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Raw LLM response — validated before use. */
interface LlmOutreachResponse {
  companyId: string;
  emails: OutreachEmail[];
  outreachSummary: string;
  reviewRequired: true;
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface CompanyRow {
  id: string;
  name: string;
  sector: string | null;
  sub_sector: string | null;
  blurb: string | null;
  estimated_valuation: string | null;
  status: string;
}

interface ContactRow {
  name: string | null;
  title: string | null;
  email: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateLlmResponse(raw: unknown, fallbackId: string): LlmOutreachResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Outreach agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  const emails = Array.isArray(r.emails) ? (r.emails as OutreachEmail[]) : [];
  if (emails.length === 0) {
    throw new Error("Outreach agent returned no email drafts");
  }

  // Enforce reviewRequired: true on every draft regardless of LLM output
  const enforced: OutreachEmail[] = emails.map((e) => ({
    sequence:       e.sequence ?? "initial",
    to:             e.to ?? null,
    toName:         String(e.toName ?? ""),
    subject:        String(e.subject ?? ""),
    body:           String(e.body ?? ""),
    reviewRequired: true,
  }));

  return {
    companyId:       String(r.companyId ?? fallbackId),
    emails:          enforced,
    outreachSummary: String(r.outreachSummary ?? ""),
    reviewRequired:  true,
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

async function fetchCompany(companyId: string): Promise<CompanyRow> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, sector, sub_sector, blurb, estimated_valuation, status")
    .eq("id", companyId)
    .single();

  if (error || !data) {
    throw new Error(`Company ${companyId} not found: ${error?.message ?? "no row"}`);
  }

  return data as CompanyRow;
}

/** Seniority order — decision-makers with email addresses are preferred. */
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
  return TITLE_PRIORITY.length;
}

async function fetchContacts(companyId: string): Promise<ContactRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("contacts")
    .select("name, title, email")
    .eq("company_id", companyId);

  const rows = (data ?? []) as ContactRow[];

  // Contacts with an email address rank higher; ties broken by seniority
  return rows.slice().sort((a, b) => {
    const emailDiff = (b.email ? 1 : 0) - (a.email ? 1 : 0);
    if (emailDiff !== 0) return emailDiff;
    return rankContact(a) - rankContact(b);
  });
}

// ---------------------------------------------------------------------------
// Outreach context defaults
// ---------------------------------------------------------------------------

function buildOutreachContext(
  callerPayload: Record<string, unknown>
): OutreachContext {
  const ctx = (callerPayload.outreachContext ?? {}) as Record<string, unknown>;
  return {
    senderName:      String(ctx.senderName ?? DEFAULT_SENDER_NAME),
    angle:           String(ctx.angle      ?? DEFAULT_ANGLE),
    personalisation: ctx.personalisation != null
      ? String(ctx.personalisation)
      : null,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(
  company: CompanyRow,
  contacts: ContactRow[],
  outreachContext: OutreachContext,
  approvedByHuman: boolean
): Promise<{ parsed: LlmOutreachResponse; modelUsed: string }> {

  // Pass the top 3 most-senior contacts with email addresses to the LLM
  const contactsForLlm = contacts.slice(0, 3).map((c) => ({
    name:  c.name  ?? "[Name unknown]",
    title: c.title ?? "[Title unknown]",
    email: c.email ?? null,
  }));

  const userMessage = JSON.stringify({
    companyId:           company.id,
    companyName:         company.name,
    sector:              company.sector,
    sub_sector:          company.sub_sector,
    blurb:               company.blurb,
    estimated_valuation: company.estimated_valuation,
    contacts:            contactsForLlm,
    outreachContext,
    approvedByHuman,
    instructions: [
      "Draft exactly THREE emails addressed to the primary contact (index 0 in the contacts list).",
      "Email 1 — sequence 'initial': Warm, concise (≤200 words) personalised outreach introducing BHAV's interest. Include: company name, sector, why BHAV is interested, proposed next steps, and a clear call to action.",
      "Email 2 — sequence 'follow_up_1': Polite 7-day follow-up (≤150 words) referencing the first email and reiterating the value of connecting.",
      "Email 3 — sequence 'follow_up_2': Final 14-day follow-up (≤120 words) keeping the door open without pressure.",
      "Set reviewRequired: true on every email — these drafts require co-founder approval before sending.",
      "Never mention that BHAV uses AI agents.",
      "Return a JSON object exactly matching this shape: { companyId, emails: [{ sequence, to, toName, subject, body, reviewRequired }], outreachSummary, reviewRequired: true }",
    ],
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 4096,
    system:     AGENT_PROMPTS.outreach,
    messages:   [{ role: "user", content: userMessage }],
  });

  if (message.content[0].type !== "text") {
    throw new Error("Claude returned a non-text content block");
  }

  const responseText = message.content[0].text;
  const modelUsed    = config.anthropic.model;

  let parsed: LlmOutreachResponse;
  try {
    parsed = validateLlmResponse(JSON.parse(responseText), company.id);
  } catch {
    throw new Error(
      `Outreach agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

async function saveOutreachResult(
  taskId: string,
  companyId: string,
  parsed: LlmOutreachResponse,
  outreachContext: OutreachContext,
  contactsTargeted: number,
  approvedByHuman: boolean,
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "outreach",
    result_type: "outreach_email",
    content: {
      emails:          parsed.emails,
      outreachSummary: parsed.outreachSummary,
      reviewRequired:  true,
      outreachContext,
      contactsTargeted,
      approvedByHuman,
      modelUsed,
      draftedAt:       nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    throw new Error(`Failed to save outreach drafts to agent_results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Outreach agent to draft a 3-email sequence (initial + 2 follow-ups)
 * for an approved deSPAC target.
 *
 * Flow:
 *   1. Enforce the human approval gate — mark failed and throw if not approved.
 *   2. Mark agent_tasks row as running.
 *   3. Fetch company record and contacts from Supabase (parallel).
 *   4. Build outreach context (caller overrides merged with BHAV defaults).
 *   5. Call Claude; fall back to OpenAI on failure.
 *   6. Validate LLM response — enforce reviewRequired: true on every email draft.
 *   7. Save all drafts to agent_results (result_type = "outreach_email").
 *   8. Mark agent_tasks completed (or failed on any error).
 *   9. Return OutreachRunResult including all email drafts.
 *
 * @param input - AgentInput; companyId at top level, optional outreach context in payload
 * @returns     OutreachRunResult with all three email drafts and metadata
 * @throws      If approvedByHuman is false/absent, or on LLM / DB errors
 */
export async function runOutreachAgent(input: AgentInput): Promise<OutreachRunResult> {
  const supabase        = createAdminClient();
  const companyId       = input.companyId ?? String((input.payload ?? {}).companyId ?? "");
  const approvedByHuman = input.approvedByHuman === true;

  if (!companyId) {
    throw new Error("Outreach agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Human approval gate — checked BEFORE marking the task running so
  //    failures are clearly attributable to missing approval
  // ------------------------------------------------------------------
  if (!approvedByHuman) {
    await createAdminClient()
      .from("agent_tasks")
      .update({
        status:       "failed",
        error:        "Outreach agent requires approvedByHuman: true. Set this flag to authorise drafting.",
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    throw new Error(
      "Outreach agent requires approvedByHuman: true. " +
        "Ensure a co-founder has explicitly approved before dispatching the Outreach agent."
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
    // 3. Fetch company + contacts (parallel)
    // ------------------------------------------------------------------
    const [company, contacts] = await Promise.all([
      fetchCompany(companyId),
      fetchContacts(companyId),
    ]);

    // ------------------------------------------------------------------
    // 4. Build outreach context
    // ------------------------------------------------------------------
    const callerPayload   = (input.payload ?? {}) as Record<string, unknown>;
    const outreachContext = buildOutreachContext(callerPayload);

    // ------------------------------------------------------------------
    // 5 + 6. Call LLM and validate response
    // ------------------------------------------------------------------
    const { parsed, modelUsed } = await callLlm(
      company,
      contacts,
      outreachContext,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 7. Save to agent_results
    // ------------------------------------------------------------------
    await saveOutreachResult(
      input.taskId,
      companyId,
      parsed,
      outreachContext,
      contacts.length,
      approvedByHuman,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 8. Mark task completed
    // ------------------------------------------------------------------
    const result: OutreachRunResult = {
      taskId:           input.taskId,
      companyId,
      companyName:      company.name,
      emails:           parsed.emails,
      outreachSummary:  parsed.outreachSummary,
      contactsTargeted: contacts.length,
      reviewRequired:   true,
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
