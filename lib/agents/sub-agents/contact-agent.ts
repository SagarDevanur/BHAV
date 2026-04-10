/**
 * Contact Agent — enriches company records with decision-maker contact data.
 *
 * Enrichment order:
 *   1. Fetch the company website with axios and extract raw HTML text
 *   2. Query Hunter.io domain-search API (requires HUNTER_API_KEY — optional)
 *   3. Call Claude with raw website text + Hunter results to extract contacts
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Upserts contacts into the contacts table linked to company_id
 *   - Sets enriched_at on every upserted contact row
 *   - Touches companies.updated_at to mark enrichment time
 *   - Writes one agent_results row (result_type = "contact")
 *
 * Input:  AgentInput — payload.companyName, payload.website, companyId at top level
 * Output: ContactRunResult
 */
import axios from "axios";
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

/** Max HTML bytes passed to Claude — enough for About/Team pages; avoids token overrun. */
const MAX_HTML_BYTES = 40_000;

/** Hunter.io domain-search endpoint. */
const HUNTER_URL = "https://api.hunter.io/v2/domain-search";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnrichedContact {
  name: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  phone: string | null;
  confidence: "low" | "medium" | "high";
  source: string;
}

export interface ContactRunResult {
  taskId: string;
  companyId: string;
  companyName: string;
  contactsUpserted: number;
  sourcesUsed: string[];
  enrichmentSummary: string;
  modelUsed: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Shape Claude returns — mirrors the contact system prompt OUTPUT schema. */
interface LlmContactResponse {
  companyId: string;
  contacts: EnrichedContact[];
  enrichmentSummary: string;
}

/** Hunter.io domain-search response (partial). */
interface HunterEmail {
  value?: string;
  type?: string;
  confidence?: number;
  first_name?: string;
  last_name?: string;
  position?: string;
  linkedin?: string;
  phone_number?: string;
}

interface HunterResponse {
  data?: {
    emails?: HunterEmail[];
    organization?: string;
  };
  errors?: Array<{ id: string; code: number; details: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Extracts the registrable domain from a URL for Hunter.io queries.
 * e.g. "https://www.example.com/about" → "example.com"
 */
function extractDomain(website: string): string | null {
  try {
    const url = new URL(
      website.startsWith("http") ? website : `https://${website}`
    );
    // Strip leading "www."
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Returns a cleaned subset of website HTML suitable for Claude.
 * Strips script/style blocks, collapses whitespace, and caps at MAX_HTML_BYTES.
 */
function cleanHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HTML_BYTES);
}

// ---------------------------------------------------------------------------
// Step 1: Website scrape
// ---------------------------------------------------------------------------

/**
 * Fetches the company website and returns cleaned visible text.
 * Tries the main URL; if that redirects or fails, tries /about and /team.
 * Returns a descriptive skip message if all attempts fail.
 */
async function scrapeWebsite(website: string | null | undefined): Promise<{
  text: string;
  source: string;
  success: boolean;
}> {
  if (!website) {
    return { text: "(no website provided)", source: "none", success: false };
  }

  const base = website.startsWith("http") ? website : `https://${website}`;

  // Pages most likely to contain team / contact info
  const candidates = [
    base,
    `${base.replace(/\/$/, "")}/about`,
    `${base.replace(/\/$/, "")}/team`,
    `${base.replace(/\/$/, "")}/contact`,
  ];

  for (const url of candidates) {
    try {
      const response = await axios.get<string>(url, {
        timeout: 10_000,
        maxRedirects: 5,
        responseType: "text",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; BHAVBot/1.0; contact@bhavacquisition.com)",
          Accept: "text/html,application/xhtml+xml",
        },
        // Don't throw on 4xx/5xx — we'll check manually
        validateStatus: (s) => s < 500,
      });

      if (response.status === 200 && typeof response.data === "string") {
        const cleaned = cleanHtml(response.data);
        if (cleaned.length > 200) {
          return { text: cleaned, source: url, success: true };
        }
      }
    } catch {
      // Try next candidate
    }
  }

  return {
    text: `(website fetch failed for ${base})`,
    source: base,
    success: false,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Hunter.io
// ---------------------------------------------------------------------------

interface HunterResult {
  emails: HunterEmail[];
  rawText: string;
  skipped: boolean;
  reason?: string;
}

/**
 * Queries Hunter.io domain-search for email addresses at the company's domain.
 * Returns a skip result if HUNTER_API_KEY is absent or the domain can't be parsed.
 */
async function fetchHunterEmails(
  website: string | null | undefined
): Promise<HunterResult> {
  const apiKey = config.hunter.apiKey;
  if (!apiKey) {
    return {
      emails: [],
      rawText: "(HUNTER_API_KEY not set — Hunter.io step skipped)",
      skipped: true,
      reason: "no api key",
    };
  }

  const domain = website ? extractDomain(website) : null;
  if (!domain) {
    return {
      emails: [],
      rawText: "(could not extract domain from website URL)",
      skipped: true,
      reason: "no domain",
    };
  }

  try {
    const response = await axios.get<HunterResponse>(HUNTER_URL, {
      timeout: 10_000,
      params: { domain, api_key: apiKey, limit: 10 },
    });

    const data = response.data;

    if (data.errors?.length) {
      const msg = data.errors.map((e) => e.details).join("; ");
      return {
        emails: [],
        rawText: `(Hunter.io error: ${msg})`,
        skipped: true,
        reason: msg,
      };
    }

    const emails = data.data?.emails ?? [];

    const rawText = emails
      .map((e) => {
        const name = [e.first_name, e.last_name].filter(Boolean).join(" ");
        return `- ${name || "Unknown"} | ${e.position ?? ""} | ${e.value ?? ""} | confidence: ${e.confidence ?? 0}%`;
      })
      .join("\n");

    return {
      emails,
      rawText: rawText || "(no emails found by Hunter.io)",
      skipped: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      emails: [],
      rawText: `(Hunter.io request failed: ${msg})`,
      skipped: true,
      reason: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 3: Claude extraction
// ---------------------------------------------------------------------------

/**
 * Sends raw website text and Hunter results to Claude to extract structured
 * contact records. Falls back to OpenAI on Anthropic failure.
 */
async function extractContactsWithLlm(
  companyId: string,
  companyName: string,
  website: string | null,
  websiteText: string,
  hunterText: string,
  approvedByHuman: boolean
): Promise<{ response: LlmContactResponse; modelUsed: string }> {
  const userMessage = JSON.stringify({
    companyId,
    companyName,
    website: website ?? null,
    approvedByHuman,
    // Grounding data for Claude — it must extract only what's present here
    rawEnrichmentData: {
      websiteText,
      hunterEmails: hunterText,
    },
    instructions:
      "Extract decision-maker contacts (CEO, CFO, CTO, President, Founder, board members) " +
      "from the rawEnrichmentData. Only include contacts with evidence in the data. " +
      "Never fabricate email addresses. Set confidence based on how directly the data " +
      "confirms each field. Prefer contacts with email addresses from the Hunter results.",
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 2048,
    system:     AGENT_PROMPTS.contact,
    messages:   [{ role: "user", content: userMessage }],
  });

  if (message.content[0].type !== "text") {
    throw new Error("Claude returned a non-text content block");
  }

  const responseText = message.content[0].text;
  const modelUsed    = config.anthropic.model;

  let parsed: LlmContactResponse;
  try {
    const raw = JSON.parse(responseText) as Record<string, unknown>;
    parsed = {
      companyId:         String(raw.companyId ?? companyId),
      contacts:          Array.isArray(raw.contacts)
        ? (raw.contacts as EnrichedContact[])
        : [],
      enrichmentSummary: String(raw.enrichmentSummary ?? ""),
    };
  } catch {
    throw new Error(
      `Contact agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { response: parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// Step 4: Upsert contacts in Supabase
// ---------------------------------------------------------------------------

/**
 * Upserts contacts for a company:
 *   - For each extracted contact, check if a row already exists for this
 *     company matched by email (when present) or by name.
 *   - If matched: update all mutable fields + set enriched_at = now().
 *   - If no match: insert a new row with enriched_at = now().
 *
 * Returns the count of rows affected (inserted + updated).
 */
async function upsertContacts(
  companyId: string,
  contacts: EnrichedContact[]
): Promise<number> {
  if (contacts.length === 0) return 0;

  const supabase = createAdminClient();

  // Fetch existing contacts for this company once
  const { data: existing, error: fetchErr } = await supabase
    .from("contacts")
    .select("id, email, name")
    .eq("company_id", companyId);

  if (fetchErr) {
    throw new Error(
      `Failed to fetch existing contacts for company ${companyId}: ${fetchErr.message}`
    );
  }

  const existingRows = existing ?? [];
  const enrichedAt   = nowIso();
  let affected       = 0;

  for (const contact of contacts) {
    // Prefer email match, fall back to name match (case-insensitive)
    const emailLower = contact.email?.toLowerCase() ?? null;
    const nameLower  = contact.name?.toLowerCase() ?? null;

    const matched = existingRows.find((row) => {
      if (emailLower && row.email) {
        return row.email.toLowerCase() === emailLower;
      }
      if (nameLower && row.name) {
        return row.name.toLowerCase() === nameLower;
      }
      return false;
    });

    if (matched) {
      // Update existing row
      const { error } = await supabase
        .from("contacts")
        .update({
          name:         contact.name,
          title:        contact.title,
          email:        contact.email,
          linkedin_url: contact.linkedin_url,
          phone:        contact.phone,
          enriched_at:  enrichedAt,
        })
        .eq("id", matched.id);

      if (error) {
        console.error(
          `[Contact agent] Failed to update contact ${matched.id}:`,
          error.message
        );
      } else {
        affected++;
      }
    } else {
      // Insert new row
      const { error } = await supabase.from("contacts").insert({
        company_id:   companyId,
        name:         contact.name,
        title:        contact.title,
        email:        contact.email,
        linkedin_url: contact.linkedin_url,
        phone:        contact.phone,
        enriched_at:  enrichedAt,
      });

      if (error) {
        console.error(
          `[Contact agent] Failed to insert contact for company ${companyId}:`,
          error.message
        );
      } else {
        affected++;
      }
    }
  }

  return affected;
}

// ---------------------------------------------------------------------------
// Step 5: Touch company updated_at to mark enrichment time
// ---------------------------------------------------------------------------

async function touchCompanyUpdatedAt(companyId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("companies")
    .update({ updated_at: nowIso() })
    .eq("id", companyId);

  if (error) {
    // Non-fatal — don't fail the task for a timestamp update
    console.error(
      "[Contact agent] Failed to touch company updated_at:",
      error.message
    );
  }
}

// ---------------------------------------------------------------------------
// Step 6: Write agent_results
// ---------------------------------------------------------------------------

async function writeAgentResult(
  taskId: string,
  companyId: string,
  contacts: EnrichedContact[],
  enrichmentSummary: string,
  sourcesUsed: string[],
  modelUsed: string
): Promise<void> {
  const supabase = createAdminClient();

  const { error } = await supabase.from("agent_results").insert({
    task_id:     taskId,
    company_id:  companyId,
    agent_name:  "contact",
    result_type: "contact",
    content: {
      contacts,
      enrichmentSummary,
      sourcesUsed,
      modelUsed,
      enrichedAt: nowIso(),
    } as unknown as Record<string, unknown>,
  });

  if (error) {
    // Non-fatal — contacts already written to the contacts table
    console.error("[Contact agent] Failed to write agent_results:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Contact agent to enrich a company's decision-maker contacts.
 *
 * Flow:
 *   1. Mark agent_tasks row as running.
 *   2. Scrape website HTML (axios, tries main + /about + /team + /contact).
 *   3. Query Hunter.io (if HUNTER_API_KEY is set).
 *   4. Call Claude with raw data to extract structured contacts.
 *   5. Upsert contacts into the contacts table (match by email then name).
 *   6. Touch companies.updated_at to mark enrichment time.
 *   7. Write one agent_results row (result_type = "contact").
 *   8. Mark agent_tasks completed (or failed on error).
 *   9. Return ContactRunResult.
 *
 * @param input - AgentInput; companyId at top level, companyName + website in payload
 * @returns     ContactRunResult with upsert count and enrichment summary
 * @throws      On LLM or critical DB errors, after marking the task failed
 */
export async function runContactAgent(input: AgentInput): Promise<ContactRunResult> {
  const supabase    = createAdminClient();
  const payload     = input.payload ?? {};
  const companyId   = input.companyId ?? String(payload.companyId ?? "");
  const companyName = String(payload.companyName ?? "Unknown Company");
  const website     =
    typeof payload.website === "string" ? payload.website : null;

  if (!companyId) {
    throw new Error("Contact agent requires a companyId");
  }

  // ------------------------------------------------------------------
  // 1. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: nowIso() })
    .eq("id", input.taskId);

  try {
    const sourcesUsed: string[] = [];

    // ------------------------------------------------------------------
    // 2. Website scrape + 3. Hunter.io (parallel)
    // ------------------------------------------------------------------
    const [websiteResult, hunterResult] = await Promise.allSettled([
      scrapeWebsite(website),
      fetchHunterEmails(website),
    ]);

    const websiteData =
      websiteResult.status === "fulfilled"
        ? websiteResult.value
        : { text: "(website scrape threw unexpectedly)", source: "error", success: false };

    const hunterData =
      hunterResult.status === "fulfilled"
        ? hunterResult.value
        : { emails: [], rawText: "(Hunter.io threw unexpectedly)", skipped: true };

    if (websiteResult.status === "rejected") {
      console.warn("[Contact agent] Website scrape threw:", websiteResult.reason);
    }
    if (hunterResult.status === "rejected") {
      console.warn("[Contact agent] Hunter.io threw:", hunterResult.reason);
    }

    if (websiteData.success) sourcesUsed.push(`website:${websiteData.source}`);
    if (!hunterData.skipped) sourcesUsed.push("hunter.io");

    // ------------------------------------------------------------------
    // 4. Claude extraction
    // ------------------------------------------------------------------
    const { response: llmResponse, modelUsed } = await extractContactsWithLlm(
      companyId,
      companyName,
      website,
      websiteData.text,
      hunterData.rawText,
      input.approvedByHuman ?? false
    );

    sourcesUsed.push(`llm:${modelUsed}`);

    // ------------------------------------------------------------------
    // 5. Upsert contacts
    // ------------------------------------------------------------------
    const contactsUpserted = await upsertContacts(companyId, llmResponse.contacts);

    // ------------------------------------------------------------------
    // 6. Touch company updated_at
    // ------------------------------------------------------------------
    await touchCompanyUpdatedAt(companyId);

    // ------------------------------------------------------------------
    // 7. Write agent_results
    // ------------------------------------------------------------------
    await writeAgentResult(
      input.taskId,
      companyId,
      llmResponse.contacts,
      llmResponse.enrichmentSummary,
      sourcesUsed,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 8. Mark task completed
    // ------------------------------------------------------------------
    const result: ContactRunResult = {
      taskId:            input.taskId,
      companyId,
      companyName,
      contactsUpserted,
      sourcesUsed,
      enrichmentSummary: llmResponse.enrichmentSummary,
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
