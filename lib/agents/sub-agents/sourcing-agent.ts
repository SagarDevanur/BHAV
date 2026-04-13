/**
 * Sourcing Agent — discovers deSPAC target companies from public data sources.
 *
 * Search order:
 *   1. SEC EDGAR full-text search (public S-1 / 10-K filings, no key required)
 *   2. Google News / NewsAPI (requires GOOGLE_NEWS_API_KEY in config)
 *   3. Claude processes the raw results and returns structured company records
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Inserts new companies into the companies table with status "sourced"
 *   - Writes one agent_results row per new company (result_type = "sourcing")
 *
 * Input:  AgentInput — payload.sector (optional), payload.searchCriteria (optional)
 * Output: SourcingRunResult
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";
import type { InsertCompany } from "@/types/database";

// ---------------------------------------------------------------------------
// LLM clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EDGAR_BASE_URL = "https://efts.sec.gov/LATEST/search-index";
const NEWS_BASE_URL  = "https://newsapi.org/v2/everything";

/** Max companies Claude is asked to return per run. */
const DEFAULT_MAX_RESULTS = 20;

/** EDGAR forms most likely to yield private/pre-IPO companies. */
const EDGAR_FORMS = "S-1,S-1%2FA,10-K12G";

/** Start date for EDGAR and news searches — rolling 18-month window. */
function searchStartDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 18);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Sector-specific search phrases used to build EDGAR + news queries. */
const SECTOR_PHRASES: Record<string, string[]> = {
  "Physical AI":     ["physical AI", "embodied AI", "AI robotics", "AI hardware startup"],
  "Drones & UAV":    ["drone startup", "UAV company", "unmanned aerial vehicle", "autonomous drone"],
  "FinTech":         ["fintech startup", "financial technology", "payments startup", "insurtech"],
  "Autonomous EVs":  ["autonomous vehicle startup", "self-driving startup", "electric vehicle startup"],
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SourcingRunResult {
  taskId: string;
  sector: string | null;
  searchQuery: string;
  totalFoundByLlm: number;
  newCompaniesInserted: number;
  skippedDuplicates: number;
  edgarResultCount: number;
  newsResultCount: number;
  modelUsed: string;
}

// ---------------------------------------------------------------------------
// Internal types for raw search results
// ---------------------------------------------------------------------------

interface EdgarHitSource {
  entity_name?: string;
  display_names?: string[];
  form_type?: string;
  file_date?: string;
  period_of_report?: string;
  biz_location?: string;
}

interface EdgarResponse {
  hits?: {
    hits?: Array<{ _source?: EdgarHitSource }>;
    total?: { value?: number };
  };
}

interface NewsArticle {
  title?: string;
  description?: string;
  url?: string;
  source?: { name?: string };
  publishedAt?: string;
}

interface NewsApiResponse {
  status?: string;
  articles?: NewsArticle[];
}

/** Shape Claude returns for each company in the sourcing prompt output. */
interface LlmCompany {
  name: string;
  website: string | null;
  sector: string;
  sub_sector: string | null;
  blurb: string | null;
  estimated_revenue: string | null;
  estimated_valuation: string | null;
  last_round: string | null;
  source: string;
}

interface LlmSourcingResponse {
  companies: LlmCompany[];
  searchSummary: string;
  totalFound: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Builds a URL-encoded search query string from sector and optional keywords.
 * Returns phrases joined with OR for broad coverage.
 */
function buildSearchQuery(
  sector: string | null | undefined,
  keywords: string[] | null | undefined
): string {
  const phrases: string[] = [];

  if (sector && SECTOR_PHRASES[sector]) {
    phrases.push(...SECTOR_PHRASES[sector]);
  } else {
    // No sector filter — use a representative cross-sector sample
    phrases.push(
      "physical AI startup",
      "drone company funding",
      "fintech startup",
      "autonomous vehicle startup"
    );
  }

  if (keywords?.length) {
    phrases.push(...keywords);
  }

  // Use the first 4 phrases to keep the query focused and within API limits
  return phrases.slice(0, 4).join(" OR ");
}

/**
 * Normalises a website URL for deduplication:
 * strips protocol, www., trailing slash, and lowercases.
 */
function normaliseWebsite(url: string | null | undefined): string | null {
  if (!url) return null;
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .trim();
}

/**
 * Normalises a company name for deduplication:
 * lowercases, strips legal suffixes, trims whitespace.
 */
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|corporation|limited|group)\b\.?/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalises a website URL for storage:
 * ensures https:// prefix.
 */
function normaliseWebsiteForStorage(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = url.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

// ---------------------------------------------------------------------------
// Step 1: SEC EDGAR search
// ---------------------------------------------------------------------------

/**
 * Searches SEC EDGAR full-text search for recent S-1 filings matching the query.
 * Returns extracted company names and context snippets for Claude to process.
 * Fails silently — if EDGAR is down the agent continues without it.
 */
async function searchEdgar(
  query: string
): Promise<{ results: EdgarHitSource[]; rawText: string }> {
  const startDate = searchStartDate();
  const encodedQuery = encodeURIComponent(`"${query.replace(/ OR /g, '" OR "')}"`.slice(0, 200));

  const url =
    `${EDGAR_BASE_URL}?q=${encodedQuery}` +
    `&forms=${EDGAR_FORMS}` +
    `&dateRange=custom&startdt=${startDate}` +
    `&_source=entity_name,display_names,form_type,file_date,biz_location` +
    `&hits.hits.total.relation=eq` +
    `&hits.hits._source=entity_name,display_names,form_type,file_date` +
    `&from=0&size=20`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "BHAV Acquisition Corp contact@bhavacquisition.com",
      "Accept":     "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`EDGAR returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as EdgarResponse;
  const hits = data.hits?.hits ?? [];
  const results: EdgarHitSource[] = hits
    .map((h) => h._source)
    .filter((s): s is EdgarHitSource => !!s);

  // Build a compact text block for Claude to parse
  const rawText = results
    .map((r) => {
      const name = r.entity_name ?? r.display_names?.[0] ?? "Unknown";
      return `- ${name} | ${r.form_type ?? ""} | Filed: ${r.file_date ?? ""} | Location: ${r.biz_location ?? ""}`;
    })
    .join("\n");

  return { results, rawText: rawText || "(no EDGAR results)" };
}

// ---------------------------------------------------------------------------
// Step 2: Google News / NewsAPI search
// ---------------------------------------------------------------------------

/**
 * Searches NewsAPI (newsapi.org) for recent articles about companies
 * in our target sectors. Requires GOOGLE_NEWS_API_KEY to be set.
 * Fails silently — if the API key is absent or the call fails, returns empty.
 */
async function searchNews(
  query: string
): Promise<{ articles: NewsArticle[]; rawText: string }> {
  const apiKey = config.googleNews.apiKey;
  if (!apiKey) {
    return { articles: [], rawText: "(GOOGLE_NEWS_API_KEY not set — news search skipped)" };
  }

  const encodedQuery = encodeURIComponent(query.slice(0, 200));
  const url =
    `${NEWS_BASE_URL}?q=${encodedQuery}` +
    `&apiKey=${apiKey}` +
    `&language=en&pageSize=20&sortBy=publishedAt` +
    `&from=${searchStartDate()}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`NewsAPI returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as NewsApiResponse;
  const articles = data.articles ?? [];

  // Build a compact text block for Claude to parse
  const rawText = articles
    .map((a) => {
      const src = a.source?.name ?? "Unknown";
      return `- [${src}] ${a.title ?? ""}: ${a.description ?? ""} | ${a.url ?? ""}`;
    })
    .join("\n");

  return { articles, rawText: rawText || "(no news results)" };
}

// ---------------------------------------------------------------------------
// Step 3: Claude extraction
// ---------------------------------------------------------------------------

/**
 * Calls Claude (with OpenAI fallback) to extract and structure company
 * records from the raw EDGAR + news search results.
 *
 * The sourcing system prompt instructs Claude not to invent companies;
 * the raw search data acts as the grounding source.
 */
async function extractCompaniesWithLlm(
  sector: string | null | undefined,
  searchQuery: string,
  edgarText: string,
  newsText: string,
  maxResults: number,
  approvedByHuman: boolean
): Promise<{ response: LlmSourcingResponse; modelUsed: string }> {
  const userMessage = JSON.stringify({
    sector:         sector ?? null,
    sub_sector:     null,
    maxResults,
    searchQuery,
    approvedByHuman,
    // Raw search data provided as grounding — Claude must extract only real
    // companies present in this data, not invent new ones.
    rawSearchData: {
      edgar: edgarText,
      news:  newsText,
    },
    instructions:
      "Extract companies from rawSearchData that match the TARGET CRITERIA. " +
      "Only include companies explicitly mentioned in the raw data. " +
      "Infer sector, sub_sector, blurb, and financials from context where possible. " +
      "Set estimated_revenue if mentioned. Use null for fields with no evidence.",
  });

  const message = await anthropic.messages.create({
    model:      config.anthropic.model,
    max_tokens: 4096,
    system:     AGENT_PROMPTS.sourcing,
    messages:   [{ role: "user", content: userMessage }],
  });

  if (message.content[0].type !== "text") {
    throw new Error("Claude returned a non-text content block");
  }

  const responseText = message.content[0].text;
  const modelUsed    = config.anthropic.model;

  // Strip markdown code fences Claude sometimes wraps around JSON output
  const jsonText = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  // Parse and validate — tolerate partial responses
  let parsed: LlmSourcingResponse;
  try {
    const raw = JSON.parse(jsonText) as Record<string, unknown>;
    parsed = {
      companies:     Array.isArray(raw.companies) ? (raw.companies as LlmCompany[]) : [],
      searchSummary: String(raw.searchSummary ?? ""),
      totalFound:    Number(raw.totalFound ?? 0),
    };
  } catch {
    throw new Error(
      `Sourcing agent received invalid JSON from ${modelUsed}: ${responseText.slice(0, 400)}`
    );
  }

  return { response: parsed, modelUsed };
}

// ---------------------------------------------------------------------------
// Step 4: Deduplication against Supabase
// ---------------------------------------------------------------------------

interface ExistingRecord {
  normalisedName: string;
  normalisedWebsite: string | null;
}

/**
 * Fetches all existing company names and websites from Supabase and
 * returns normalised sets for O(1) dedup lookups.
 */
async function fetchExistingCompanyIndex(): Promise<ExistingRecord[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("companies")
    .select("name, website");

  if (error) {
    throw new Error(`Failed to fetch existing companies for dedup: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    normalisedName:    normaliseName(row.name),
    normalisedWebsite: normaliseWebsite(row.website),
  }));
}

/**
 * Returns the subset of Claude-returned companies that are not already
 * in the existing index (matched by normalised name OR normalised website).
 */
function filterNewCompanies(
  candidates: LlmCompany[],
  existing: ExistingRecord[]
): LlmCompany[] {
  const existingNames    = new Set(existing.map((e) => e.normalisedName));
  const existingWebsites = new Set(
    existing
      .map((e) => e.normalisedWebsite)
      .filter((w): w is string => w !== null)
  );

  return candidates.filter((c) => {
    if (existingNames.has(normaliseName(c.name))) return false;
    const normWeb = normaliseWebsite(c.website);
    if (normWeb && existingWebsites.has(normWeb)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Step 5: Insert new companies
// ---------------------------------------------------------------------------

/**
 * Inserts a batch of new companies into the companies table.
 * Returns the inserted rows (with their generated IDs).
 */
async function insertNewCompanies(
  companies: LlmCompany[]
): Promise<Array<{ id: string; name: string }>> {
  if (companies.length === 0) return [];

  const supabase = createAdminClient();

  const inserts: InsertCompany[] = companies.map((c) => {
    // The DB has no estimated_revenue column — fold it into the blurb
    const blurbWithRevenue =
      c.estimated_revenue
        ? `${c.blurb ?? ""}${c.blurb ? " " : ""}Est. revenue: ${c.estimated_revenue}.`.trim()
        : (c.blurb ?? null);

    return {
      name:                c.name,
      website:             normaliseWebsiteForStorage(c.website),
      sector:              c.sector ?? null,
      sub_sector:          c.sub_sector ?? null,
      blurb:               blurbWithRevenue,
      last_round:          c.last_round ?? null,
      estimated_valuation: c.estimated_valuation ?? null,
      despac_score:        null,
      status:              "sourced" as const,
    };
  });

  const { data, error } = await supabase
    .from("companies")
    .insert(inserts)
    .select("id, name");

  if (error) {
    throw new Error(`Failed to insert companies: ${error.message}`);
  }

  return (data ?? []) as Array<{ id: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Step 6: Write agent_results per inserted company
// ---------------------------------------------------------------------------

async function writeAgentResults(
  taskId: string,
  insertedCompanies: Array<{ id: string; name: string }>,
  searchSummary: string,
  modelUsed: string
): Promise<void> {
  if (insertedCompanies.length === 0) return;

  const supabase = createAdminClient();

  const rows = insertedCompanies.map((company) => ({
    task_id:     taskId,
    company_id:  company.id,
    agent_name:  "sourcing",
    result_type: "sourcing",
    content:     {
      companyName:   company.name,
      searchSummary,
      modelUsed,
      discoveredAt:  nowIso(),
    } as Record<string, unknown>,
  }));

  const { error } = await supabase.from("agent_results").insert(rows);

  if (error) {
    // Non-fatal — companies are already inserted; don't fail the task
    console.error("[Sourcing agent] Failed to write agent_results:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the Sourcing agent.
 *
 * Flow:
 *   1. Mark agent_tasks row as running.
 *   2. Build search query from sector + keywords in payload.
 *   3. Fetch raw results from EDGAR (always) and NewsAPI (if key present).
 *   4. Call Claude to extract structured company records from raw data.
 *   5. Dedup against existing Supabase companies by name + website.
 *   6. Insert new companies with status "sourced".
 *   7. Write one agent_results row per new company (result_type = "sourcing").
 *   8. Mark agent_tasks completed (or failed on error).
 *   9. Return SourcingRunResult summary.
 *
 * @param input - AgentInput; sector in payload.sector, keywords in payload.searchCriteria
 * @returns     SourcingRunResult with counts of discovered and inserted companies
 * @throws      On LLM or critical database errors, after marking the task failed
 */
export async function runSourcingAgent(input: AgentInput): Promise<SourcingRunResult> {
  const supabase = createAdminClient();
  const payload  = input.payload ?? {};

  const sector   = typeof payload.sector === "string" ? payload.sector : null;
  const criteria = (payload.searchCriteria ?? {}) as Record<string, unknown>;
  const keywords = Array.isArray(criteria.keywords)
    ? (criteria.keywords as string[])
    : null;
  const maxResults =
    typeof criteria.maxResults === "number" ? criteria.maxResults : DEFAULT_MAX_RESULTS;

  // ------------------------------------------------------------------
  // 1. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: nowIso() })
    .eq("id", input.taskId);

  try {
    // ------------------------------------------------------------------
    // 2. Build search query
    // ------------------------------------------------------------------
    const searchQuery = buildSearchQuery(sector, keywords);

    // ------------------------------------------------------------------
    // 3. Parallel: EDGAR + NewsAPI
    // ------------------------------------------------------------------
    const [edgarResult, newsResult] = await Promise.allSettled([
      searchEdgar(searchQuery),
      searchNews(searchQuery),
    ]);

    const edgarText =
      edgarResult.status === "fulfilled"
        ? edgarResult.value.rawText
        : `(EDGAR search failed: ${edgarResult.reason instanceof Error ? edgarResult.reason.message : String(edgarResult.reason)})`;

    const edgarCount =
      edgarResult.status === "fulfilled" ? edgarResult.value.results.length : 0;

    const newsText =
      newsResult.status === "fulfilled"
        ? newsResult.value.rawText
        : `(News search failed: ${newsResult.reason instanceof Error ? newsResult.reason.message : String(newsResult.reason)})`;

    const newsCount =
      newsResult.status === "fulfilled" ? newsResult.value.articles.length : 0;

    if (edgarResult.status === "rejected") {
      console.warn("[Sourcing agent] EDGAR search failed:", edgarResult.reason);
    }
    if (newsResult.status === "rejected") {
      console.warn("[Sourcing agent] News search failed:", newsResult.reason);
    }

    // ------------------------------------------------------------------
    // 4. Claude extracts structured companies from raw results
    // ------------------------------------------------------------------
    const { response: llmResponse, modelUsed } = await extractCompaniesWithLlm(
      sector,
      searchQuery,
      edgarText,
      newsText,
      maxResults,
      input.approvedByHuman ?? false
    );

    // ------------------------------------------------------------------
    // 5. Dedup against existing Supabase records
    // ------------------------------------------------------------------
    const existingIndex = await fetchExistingCompanyIndex();
    const newCandidates = filterNewCompanies(llmResponse.companies, existingIndex);
    const skipped       = llmResponse.companies.length - newCandidates.length;

    // ------------------------------------------------------------------
    // 6. Insert new companies
    // ------------------------------------------------------------------
    const inserted = await insertNewCompanies(newCandidates);

    // ------------------------------------------------------------------
    // 7. Write agent_results per inserted company
    // ------------------------------------------------------------------
    await writeAgentResults(
      input.taskId,
      inserted,
      llmResponse.searchSummary,
      modelUsed
    );

    // ------------------------------------------------------------------
    // 8. Mark task completed
    // ------------------------------------------------------------------
    const result: SourcingRunResult = {
      taskId:              input.taskId,
      sector,
      searchQuery,
      totalFoundByLlm:     llmResponse.companies.length,
      newCompaniesInserted: inserted.length,
      skippedDuplicates:   skipped,
      edgarResultCount:    edgarCount,
      newsResultCount:     newsCount,
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
