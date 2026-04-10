/**
 * SEC Agent — drafts S-4 registration statement sections for deSPAC transactions.
 *
 * HUMAN APPROVAL GATE:
 *   - approvedByHuman: false → agent refuses immediately; task marked failed
 *   - approvedByHuman: true  → full S-4 draft is produced and saved
 *
 * The draft is NEVER filed or submitted by this agent. Legal review is always required.
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Writes agent_results row with result_type = "sec_draft"
 *
 * Input:  AgentInput — companyId at top level, optional deal params in payload.dealParameters
 * Output: SecRunResult
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

const BHAV_SPAC_NAME        = "BHAV Acquisition Corp";
const DEFAULT_SPAC_TRUST    = "$150M";
const DEFAULT_DEAL_STRUCTURE = "deSPAC merger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecDealParameters {
  /** Proposed enterprise value, e.g. "$120M–$150M". */
  proposedValuation: string;
  /** Deal structure, e.g. "deSPAC merger". */
  structure: string;
  /** SPAC entity name. */
  spac_name: string;
  /** Estimated SPAC trust size, e.g. "$150M". */
  spac_trust_size: string;
}

export interface SecRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  /** Full S-4 draft text in markdown — ready for dashboard display. */
  s4_draft: string;
  /** Items that must be provided before the filing can be completed. */
  missingDataFlags: string[];
  /** Word count of the draft. */
  wordCount: number;
  /** Always true — SEC filings require attorney review before submission. */
  legalReviewRequired: true;
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Raw LLM response — validated before use. */
interface LlmSecResponse {
  companyId: string;
  section: string;
  draft: string;
  legalReviewRequired: true;
  missingDataFlags: string[];
  wordCount: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateLlmResponse(raw: unknown, fallbackId: string): LlmSecResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("SEC agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  const draft = String(r.draft ?? "").trim();
  if (!draft) {
    throw new Error("SEC agent returned an empty draft");
  }

  const wordCount =
    typeof r.wordCount === "number"
      ? r.wordCount
      : draft.split(/\s+/).filter(Boolean).length;

  return {
    companyId:           String(r.companyId ?? fallbackId),
    section:             String(r.section ?? "full_s4"),
    draft,
    legalReviewRequired: true, // always enforce — never trust LLM to set this
    missingDataFlags:    Array.isArray(r.missingDataFlags)
      ? (r.missingDataFlags as string[])
      : [],
    wordCount,
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
  website: string | null;
  sector: string | null;
  sub_sector: string | null;
  blurb: string | null;
  last_round: string | null;
  estimated_valuation: string | null;
  despac_score: number | null;
  status: string;
}

interface ContactRow {
  name: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
}

interface CfoScoreContent {
  despac_score?: number;
  score_breakdown?: {
    revenue_fit?: number;
    valuation_band?: number;
    sector_alignment?: number;
    redemption_risk?: number;
  };
  rationale?: {
    revenue_fit?: string;
    valuation_band?: string;
    sector_alignment?: string;
    redemption_risk?: string;
  };
  recommendation?: string;
  confidence?: string;
}

async function fetchCompany(companyId: string): Promise<CompanyRow> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id, name, website, sector, sub_sector, blurb, last_round, estimated_valuation, despac_score, status"
    )
    .eq("id", companyId)
    .single();

  if (error || !data) {
    throw new Error(`Company ${companyId} not found: ${error?.message ?? "no row"}`);
  }

  return data as CompanyRow;
}

async function fetchContacts(companyId: string): Promise<ContactRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("contacts")
    .select("name, title, email, linkedin_url")
    .eq("company_id", companyId);

  return (data ?? []) as ContactRow[];
}

/**
 * Fetches the most recent CFO agent score breakdown from agent_results.
 * Returns null if no CFO result exists for this company.
 */
async function fetchCfoScore(companyId: string): Promise<CfoScoreContent | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_results")
    .select("content")
    .eq("company_id", companyId)
    .eq("agent_name", "cfo")
    .order("created_at", { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return null;

  const row = data[0] as { content: unknown };
  if (typeof row.content !== "object" || row.content === null) return null;

  return row.content as CfoScoreContent;
}

// ---------------------------------------------------------------------------
// Deal parameter defaults
// ---------------------------------------------------------------------------

/**
 * Merges caller-supplied deal parameters with BHAV defaults.
 * Derives a proposed valuation from the stored estimate when not supplied.
 */
function buildDealParameters(
  company: CompanyRow,
  callerParams: Record<string, unknown> | undefined
): SecDealParameters {
  const params = callerParams ?? {};

  let proposedValuation = String(params.proposedValuation ?? "");
  if (!proposedValuation && company.estimated_valuation) {
    proposedValuation = `~${company.estimated_valuation} (subject to due diligence)`;
  }
  if (!proposedValuation) {
    proposedValuation = "[PROPOSED VALUATION — TO BE COMPLETED]";
  }

  return {
    proposedValuation,
    structure:       String(params.structure       ?? DEFAULT_DEAL_STRUCTURE),
    spac_name:       String(params.spac_name       ?? BHAV_SPAC_NAME),
    spac_trust_size: String(params.spac_trust_size ?? DEFAULT_SPAC_TRUST),
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

/**
 * Builds the financial summary object passed to the LLM.
 * Combines company-level fields with the CFO score breakdown.
 */
function buildFinancialSummary(
  company: CompanyRow,
  cfoScore: CfoScoreContent | null
): Record<string, unknown> {
  return {
    estimated_valuation: company.estimated_valuation ?? "[PLACEHOLDER]",
    last_round:          company.last_round          ?? "[PLACEHOLDER]",
    despac_score:        company.despac_score        ?? cfoScore?.despac_score ?? null,
    cfo_score_breakdown: cfoScore?.score_breakdown   ?? null,
    cfo_rationale:       cfoScore?.rationale         ?? null,
    cfo_recommendation:  cfoScore?.recommendation    ?? null,
    cfo_confidence:      cfoScore?.confidence        ?? null,
  };
}

async function callLlm(
  company: CompanyRow,
  contacts: ContactRow[],
  cfoScore: CfoScoreContent | null,
  dealParameters: SecDealParameters,
  approvedByHuman: boolean
): Promise<{ parsed: LlmSecResponse; modelUsed: string }> {
  const financialSummary = buildFinancialSummary(company, cfoScore);

  // Request the full S-4 in one call across all required sections.
  const userMessage = JSON.stringify({
    companyId:        company.id,
    companyName:      company.name,
    sector:           company.sector,
    sub_sector:       company.sub_sector,
    blurb:            company.blurb,
    website:          company.website,
    dealParameters,
    financialSummary,
    contacts,
    section:          "full_s4",
    sectionsRequired: [
      "business_description",
      "risk_factors",
      "use_of_proceeds",
      "management_discussion_and_analysis",
      "financial_statements_placeholder",
    ],
    instructions:
      "Draft a complete S-4 registration statement for this deSPAC transaction. " +
      "Include all five sections listed in sectionsRequired as clearly headed markdown sections. " +
      "Use [PLACEHOLDER] for any financial figures that are not supplied. " +
      "Set legalReviewRequired to true. " +
      "Return a single JSON object with: companyId, section (set to 'full_s4'), draft (the full markdown text), " +
      "legalReviewRequired, missingDataFlags (array of strings), wordCount (integer).",
    approvedByHuman,
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 8192,
    system:     AGENT_PROMPTS.sec,
    messages:   [{ role: "user", content: userMessage }],
  });

  if (message.content[0].type !== "text") {
    throw new Error("Claude returned a non-text content block");
  }

  const responseText = message.content[0].text;
  const modelUsed    = config.anthropic.model;

  // Strip markdown code fences if the model wrapped the JSON
  const jsonText = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: LlmSecResponse;
  try {
    parsed = validateLlmResponse(JSON.parse(jsonText), company.id);
  } catch {
    throw new Error(
      `SEC agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

async function saveSecResult(
  taskId: string,
  companyId: string,
  parsed: LlmSecResponse,
  dealParameters: SecDealParameters,
  approvedByHuman: boolean,
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "sec",
    result_type: "sec_draft",
    content: {
      section:             parsed.section,
      s4_draft:            parsed.draft,
      legalReviewRequired: true,
      missingDataFlags:    parsed.missingDataFlags,
      wordCount:           parsed.wordCount,
      dealParameters,
      approvedByHuman,
      modelUsed,
      draftedAt:           nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    throw new Error(`Failed to save SEC draft to agent_results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the SEC agent to draft a full S-4 registration statement.
 *
 * Flow:
 *   1. Enforce the human approval gate — mark failed and throw if not approved.
 *   2. Mark agent_tasks row as running.
 *   3. Fetch company record, contacts, and CFO score breakdown in parallel.
 *   4. Build deal parameters (caller-supplied terms merged with BHAV defaults).
 *   5. Call Claude (full S-4, all sections); fall back to OpenAI on failure.
 *   6. Validate LLM response — enforce legalReviewRequired: true regardless of LLM output.
 *   7. Save SEC draft to agent_results (result_type = "sec_draft").
 *   8. Mark agent_tasks completed (or failed on any error).
 *   9. Return SecRunResult including full S-4 draft text for dashboard display.
 *
 * @param input - AgentInput; companyId at top level, optional deal params in payload.dealParameters
 * @returns     SecRunResult with full S-4 markdown and metadata
 * @throws      If approvedByHuman is false/absent, or on LLM / DB errors
 */
export async function runSecAgent(input: AgentInput): Promise<SecRunResult> {
  const supabase        = createAdminClient();
  const companyId       = input.companyId ?? String((input.payload ?? {}).companyId ?? "");
  const approvedByHuman = input.approvedByHuman === true;

  if (!companyId) {
    throw new Error("SEC agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Human approval gate — checked BEFORE marking the task running
  // ------------------------------------------------------------------
  if (!approvedByHuman) {
    await supabase
      .from("agent_tasks")
      .update({
        status:       "failed",
        error:        "SEC agent requires approvedByHuman: true. Set this flag to authorise drafting.",
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    throw new Error(
      "SEC agent requires approvedByHuman: true. " +
        "Ensure a co-founder has explicitly approved before dispatching the SEC agent."
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
    // 3. Fetch company, contacts, and CFO score in parallel
    // ------------------------------------------------------------------
    const [company, contacts, cfoScore] = await Promise.all([
      fetchCompany(companyId),
      fetchContacts(companyId),
      fetchCfoScore(companyId),
    ]);

    // ------------------------------------------------------------------
    // 4. Build deal parameters
    // ------------------------------------------------------------------
    const callerParams = (input.payload?.dealParameters ?? {}) as Record<string, unknown>;
    const dealParameters = buildDealParameters(company, callerParams);

    // ------------------------------------------------------------------
    // 5 + 6. Call LLM and validate response
    // ------------------------------------------------------------------
    const { parsed, modelUsed } = await callLlm(
      company,
      contacts,
      cfoScore,
      dealParameters,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 7. Save to agent_results
    // ------------------------------------------------------------------
    await saveSecResult(
      input.taskId,
      companyId,
      parsed,
      dealParameters,
      approvedByHuman,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 8. Mark task completed
    // ------------------------------------------------------------------
    const result: SecRunResult = {
      taskId:              input.taskId,
      companyId,
      companyName:         company.name,
      s4_draft:            parsed.draft,
      missingDataFlags:    parsed.missingDataFlags,
      wordCount:           parsed.wordCount,
      legalReviewRequired: true,
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
