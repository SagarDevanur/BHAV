/**
 * Narrative Agent — crafts three deal documents for approved deSPAC targets.
 *
 * DOCUMENTS PRODUCED (in one LLM call):
 *   1. investor_story     — ~2-page narrative on why this company is a strong deSPAC candidate
 *   2. press_release      — draft announcement of the proposed business combination
 *   3. executive_summary  — 1-page overview for PIPE investors
 *
 * HUMAN APPROVAL GATE:
 *   - approvedByHuman: false → task marked failed; nothing is produced
 *   - approvedByHuman: true  → documents are drafted and saved; never published by this agent
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Writes agent_results row with result_type = "narrative"
 *
 * Input:  AgentInput — companyId at top level, optional overrides in payload
 * Output: NarrativeRunResult
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
// Types
// ---------------------------------------------------------------------------

export interface NarrativeRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  /** ~2-page markdown narrative on why this company is a strong deSPAC candidate. */
  investor_story: string;
  /** Draft press release announcing the proposed business combination. */
  press_release: string;
  /** 1-page markdown overview for PIPE investors. */
  executive_summary: string;
  /** Title used across all three documents. */
  narrativeTitle: string;
  /** One-sentence executive summary used in the monitor view. */
  synopsis: string;
  /** Key risks flagged by the agent. */
  keyRisks: string[];
  /** Always true — documents must never be published without co-founder approval. */
  reviewRequired: true;
  approvedByHuman: boolean;
  modelUsed: string;
}

/** Raw LLM response shape — validated before use. */
interface LlmNarrativeResponse {
  companyId: string;
  narrativeTitle: string;
  investor_story: string;
  press_release: string;
  executive_summary: string;
  synopsis: string;
  keyRisks: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateLlmResponse(raw: unknown, fallbackId: string): LlmNarrativeResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Narrative agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  const investor_story    = String(r.investor_story    ?? r.fullNarrative ?? "").trim();
  const press_release     = String(r.press_release     ?? "").trim();
  const executive_summary = String(r.executive_summary ?? r.executiveSummary ?? "").trim();

  if (!investor_story) {
    throw new Error("Narrative agent returned an empty investor_story");
  }
  if (!press_release) {
    throw new Error("Narrative agent returned an empty press_release");
  }
  if (!executive_summary) {
    throw new Error("Narrative agent returned an empty executive_summary");
  }

  return {
    companyId:         String(r.companyId ?? fallbackId),
    narrativeTitle:    String(r.narrativeTitle ?? ""),
    investor_story,
    press_release,
    executive_summary,
    synopsis:          String(r.synopsis ?? r.executiveSummary ?? ""),
    keyRisks:          Array.isArray(r.keyRisks) ? (r.keyRisks as string[]) : [],
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
    .select("name, title, email")
    .eq("company_id", companyId);

  return (data ?? []) as ContactRow[];
}

/**
 * Fetches the most recent CFO score breakdown from agent_results.
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
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(
  company: CompanyRow,
  contacts: ContactRow[],
  cfoScore: CfoScoreContent | null,
  audienceType: string,
  approvedByHuman: boolean
): Promise<{ parsed: LlmNarrativeResponse; modelUsed: string }> {
  const userMessage = JSON.stringify({
    companyId:            company.id,
    companyName:          company.name,
    sector:               company.sector,
    sub_sector:           company.sub_sector,
    blurb:                company.blurb,
    estimated_valuation:  company.estimated_valuation,
    last_round:           company.last_round,
    despac_score:         company.despac_score ?? cfoScore?.despac_score ?? null,
    score_rationale:      cfoScore?.rationale
      ? JSON.stringify(cfoScore.rationale)
      : null,
    cfo_score_breakdown:  cfoScore?.score_breakdown  ?? null,
    cfo_recommendation:   cfoScore?.recommendation   ?? null,
    contacts,
    dealParameters:       null,
    audienceType,
    approvedByHuman,
    documentsRequired: [
      "investor_story",
      "press_release",
      "executive_summary",
    ],
    instructions:
      "Produce all three documents in a single JSON response. " +
      "investor_story: ~2 pages of compelling markdown narrative on why this company is a strong deSPAC candidate. " +
      "press_release: a professional draft press release announcing the proposed business combination between BHAV Acquisition Corp and this company. " +
      "executive_summary: a concise 1-page markdown overview designed for PIPE investors. " +
      "Also include: narrativeTitle (string), synopsis (1–2 sentence summary), keyRisks (string[]). " +
      "Return a JSON object with keys: companyId, narrativeTitle, investor_story, press_release, executive_summary, synopsis, keyRisks. " +
      "Use [PLACEHOLDER] for any figures not supplied. Never fabricate financial data.",
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 8192,
    system:     AGENT_PROMPTS.narrative,
    messages:   [{ role: "user", content: userMessage }],
  });

  if (message.content[0].type !== "text") {
    throw new Error("Claude returned a non-text content block");
  }

  const responseText = message.content[0].text;
  const modelUsed    = config.anthropic.model;

  // Strip markdown code fences if the model wrapped its response
  const jsonText = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: LlmNarrativeResponse;
  try {
    parsed = validateLlmResponse(JSON.parse(jsonText), company.id);
  } catch {
    throw new Error(
      `Narrative agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

async function saveNarrativeResult(
  taskId: string,
  companyId: string,
  parsed: LlmNarrativeResponse,
  approvedByHuman: boolean,
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "narrative",
    result_type: "narrative",
    content: {
      narrativeTitle:    parsed.narrativeTitle,
      investor_story:    parsed.investor_story,
      press_release:     parsed.press_release,
      executive_summary: parsed.executive_summary,
      synopsis:          parsed.synopsis,
      keyRisks:          parsed.keyRisks,
      reviewRequired:    true,
      approvedByHuman,
      modelUsed,
      draftedAt:         nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    throw new Error(`Failed to save narrative to agent_results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Narrative agent to produce three deal documents for a target company.
 *
 * Flow:
 *   1. Enforce the human approval gate — mark failed and throw if not approved.
 *   2. Mark agent_tasks row as running.
 *   3. Fetch company record, contacts, and CFO score breakdown in parallel.
 *   4. Call Claude requesting all three documents in one response; fall back to OpenAI.
 *   5. Validate LLM response — all three document fields must be non-empty.
 *   6. Save all documents to agent_results (result_type = "narrative").
 *   7. Mark agent_tasks completed (or failed on any error).
 *   8. Return NarrativeRunResult with all three documents for dashboard display.
 *
 * @param input - AgentInput; companyId at top level, optional audienceType in payload
 * @returns     NarrativeRunResult with investor_story, press_release, executive_summary
 * @throws      If approvedByHuman is false/absent, or on LLM / DB errors
 */
export async function runNarrativeAgent(input: AgentInput): Promise<NarrativeRunResult> {
  const supabase        = createAdminClient();
  const companyId       = input.companyId ?? String((input.payload ?? {}).companyId ?? "");
  const approvedByHuman = input.approvedByHuman === true;

  if (!companyId) {
    throw new Error("Narrative agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Human approval gate
  // ------------------------------------------------------------------
  if (!approvedByHuman) {
    await supabase
      .from("agent_tasks")
      .update({
        status:       "failed",
        error:        "Narrative agent requires approvedByHuman: true. Set this flag to authorise document drafting.",
        completed_at: nowIso(),
      })
      .eq("id", input.taskId);

    throw new Error(
      "Narrative agent requires approvedByHuman: true. " +
        "Ensure a co-founder has explicitly approved before dispatching the Narrative agent."
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

    // audienceType defaults to "investor" — can be overridden via payload
    const audienceType = String(
      (input.payload ?? {}).audienceType ?? "investor"
    );

    // ------------------------------------------------------------------
    // 4 + 5. Call LLM and validate response
    // ------------------------------------------------------------------
    const { parsed, modelUsed } = await callLlm(
      company,
      contacts,
      cfoScore,
      audienceType,
      approvedByHuman
    );

    // ------------------------------------------------------------------
    // 6. Save to agent_results
    // ------------------------------------------------------------------
    await saveNarrativeResult(
      input.taskId,
      companyId,
      parsed,
      approvedByHuman,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 7. Mark task completed
    // ------------------------------------------------------------------
    const result: NarrativeRunResult = {
      taskId:            input.taskId,
      companyId,
      companyName:       company.name,
      narrativeTitle:    parsed.narrativeTitle,
      investor_story:    parsed.investor_story,
      press_release:     parsed.press_release,
      executive_summary: parsed.executive_summary,
      synopsis:          parsed.synopsis,
      keyRisks:          parsed.keyRisks,
      reviewRequired:    true,
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
