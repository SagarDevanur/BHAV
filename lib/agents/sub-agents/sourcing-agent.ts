/**
 * Sourcing Agent — discovers deSPAC target companies from public data sources.
 *
 * Search order:
 *   1. YCombinator API  — finds YC-backed companies in our target sectors (no key required)
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

const NEWS_BASE_URL = "https://newsapi.org/v2/everything";
const YC_API_URL    = "https://api.ycombinator.com/v0.1/companies";

/** Max companies Claude is asked to return per run. */
const DEFAULT_MAX_RESULTS = 20;

/** Rolling 18-month window start date for news searches. */
function searchStartDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 18);
  return d.toISOString().slice(0, 10);
}

/**
 * Sector-specific search phrases used for News and YC queries.
 * Each entry has a news phrase (for NewsAPI) and a yc tag (for YC API q= param).
 */
const SECTOR_CONFIG: Record<
  string,
  { newsPhrases: string[]; ycQueries: string[] }
> = {
  "Physical AI": {
    newsPhrases: ["physical AI startup", "embodied AI funding", "AI robotics startup"],
    ycQueries:   ["physical AI", "embodied AI", "AI robotics hardware"],
  },
  "Drones & UAV": {
    newsPhrases: ["drone startup funding", "UAV company revenue", "unmanned aerial vehicle startup"],
    ycQueries:   ["drone", "UAV", "unmanned aerial"],
  },
  "FinTech": {
    newsPhrases: ["fintech startup Series", "payments startup funding", "insurtech revenue"],
    ycQueries:   ["fintech", "payments", "insurtech"],
  },
  "Autonomous EVs": {
    newsPhrases: ["autonomous vehicle startup funding", "self-driving startup revenue", "electric vehicle startup"],
    ycQueries:   ["autonomous vehicle", "self-driving", "electric vehicle"],
  },
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
  ycResultCount: number;
  newsResultCount: number;
  modelUsed: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface YcCompanyRaw {
  name?: string;
  slug?: string;
  website?: string;
  one_liner?: string;
  long_description?: string;
  batch?: string;
  status?: string;
  all_locations?: string;
  tags?: string[];
}

interface YcApiResponse {
  companies?: YcCompanyRaw[];
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
 * Builds a human-readable search query string from sector phrases.
 * Used as the `searchQuery` field in SourcingRunResult.
 */
function buildSearchQuery(
  sector: string | null | undefined,
  keywords: string[] | null | undefined,
): string {
  const cfg = sector ? SECTOR_CONFIG[sector] : null;
  const phrases = cfg
    ? cfg.newsPhrases
    : ["physical AI startup", "drone company funding", "fintech startup", "autonomous vehicle startup"];

  const extras = keywords?.length ? keywords : [];
  return [...phrases.slice(0, 3), ...extras.slice(0, 2)].join(" OR ");
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
// Step 1: YCombinator API search
// ---------------------------------------------------------------------------

/**
 * Searches the public YCombinator API for companies matching the sector.
 * Runs multiple queries (one per ycQueries entry) and deduplicates results.
 * Returns a compact text block for Claude to process.
 *
 * Fails silently — if YC API is unreachable the agent continues without it.
 */
async function searchYcombinator(
  sector: string | null | undefined,
): Promise<{ results: YcCompanyRaw[]; rawText: string }> {
  const cfg      = sector ? SECTOR_CONFIG[sector] : null;
  const queries  = cfg?.ycQueries ?? ["startup funding", "tech company", "AI company", "fintech"];
  const seen     = new Set<string>();
  const allHits: YcCompanyRaw[] = [];

  for (const q of queries.slice(0, 3)) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 5_000);

    try {
      const url = `${YC_API_URL}?q=${encodeURIComponent(q)}&status=Active`;
      const res = await fetch(url, {
        signal:  controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!res.ok) continue;

      const json = (await res.json()) as YcApiResponse;
      for (const c of json.companies ?? []) {
        const key = (c.name ?? "").toLowerCase().trim();
        if (key && !seen.has(key)) {
          seen.add(key);
          allHits.push(c);
        }
      }
    } catch {
      // Timeout or network error on this query — skip and continue
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const rawText =
    allHits
      .slice(0, 30)
      .map(
        (c) =>
          `- ${c.name ?? "?"} | Batch: ${c.batch ?? "?"} | ${c.one_liner ?? ""} | ${c.website ?? ""} | Tags: ${(c.tags ?? []).join(", ")}`,
      )
      .join("\n") || "(no YC results)";

  return { results: allHits.slice(0, 30), rawText };
}

// ---------------------------------------------------------------------------
// Step 2: Google News / NewsAPI search
// ---------------------------------------------------------------------------

/**
 * Searches NewsAPI for recent articles about companies in our target sectors.
 * Requires GOOGLE_NEWS_API_KEY — returns empty results when absent.
 * Fails silently on network errors.
 */
async function searchNews(
  query: string,
): Promise<{ articles: NewsArticle[]; rawText: string }> {
  const apiKey = config.googleNews.apiKey;
  if (!apiKey) {
    return { articles: [], rawText: "(GOOGLE_NEWS_API_KEY not set — news search skipped)" };
  }

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 10_000);

  try {
    const encodedQuery = encodeURIComponent(query.slice(0, 200));
    const url =
      `${NEWS_BASE_URL}?q=${encodedQuery}` +
      `&apiKey=${apiKey}` +
      `&language=en&pageSize=20&sortBy=publishedAt` +
      `&from=${searchStartDate()}`;

    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`NewsAPI returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as NewsApiResponse;
    const articles = data.articles ?? [];

    const rawText =
      articles
        .map((a) => {
          const src = a.source?.name ?? "Unknown";
          return `- [${src}] ${a.title ?? ""}: ${a.description ?? ""} | ${a.url ?? ""}`;
        })
        .join("\n") || "(no news results)";

    return { articles, rawText };
  } catch {
    return { articles: [], rawText: "(news search failed)" };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Step 3: Claude extraction
// ---------------------------------------------------------------------------

/**
 * Calls Claude to extract and structure company records from YC + news results.
 * The sourcing system prompt instructs Claude not to invent companies —
 * raw search data acts as grounding.
 */
async function extractCompaniesWithLlm(
  sector: string | null | undefined,
  searchQuery: string,
  ycText: string,
  newsText: string,
  maxResults: number,
  approvedByHuman: boolean,
): Promise<{ response: LlmSourcingResponse; modelUsed: string }> {
  const userMessage = JSON.stringify({
    sector:         sector ?? null,
    sub_sector:     null,
    maxResults,
    searchQuery,
    approvedByHuman,
    // Raw search data — Claude must extract only companies present in this data
    rawSearchData: {
      yc_companies: ycText,
      news:         newsText,
    },
    instructions:
      "Extract companies from rawSearchData that match the TARGET CRITERIA. " +
      "Only include companies explicitly mentioned in the raw data. " +
      "YC-backed companies (from yc_companies) are high-quality targets — include them when they match sector and stage criteria. " +
      "Infer sector, sub_sector, blurb, and financials from context where possible. " +
      "Set last_round to the YC batch string (e.g. 'YC W22') for YC companies when no other round is known. " +
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
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

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
 * returns normalised records for O(1) dedup lookups.
 */
async function fetchExistingCompanyIndex(): Promise<ExistingRecord[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("companies").select("name, website");

  if (error) {
    throw new Error(`Failed to fetch existing companies for dedup: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    normalisedName:    normaliseName(row.name),
    normalisedWebsite: normaliseWebsite(row.website),
  }));
}

/**
 * Returns the subset of Claude-returned companies not already in the
 * existing index (matched by normalised name OR normalised website).
 */
function filterNewCompanies(
  candidates: LlmCompany[],
  existing: ExistingRecord[],
): LlmCompany[] {
  const existingNames    = new Set(existing.map((e) => e.normalisedName));
  const existingWebsites = new Set(
    existing.map((e) => e.normalisedWebsite).filter((w): w is string => w !== null),
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
  companies: LlmCompany[],
): Promise<Array<{ id: string; name: string }>> {
  if (companies.length === 0) return [];

  const supabase = createAdminClient();

  const inserts: InsertCompany[] = companies.map((c) => {
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
  modelUsed: string,
): Promise<void> {
  if (insertedCompanies.length === 0) return;

  const supabase = createAdminClient();

  const rows = insertedCompanies.map((company) => ({
    task_id:     taskId,
    company_id:  company.id,
    agent_name:  "sourcing",
    result_type: "sourcing",
    content: {
      companyName:   company.name,
      searchSummary,
      modelUsed,
      discoveredAt:  nowIso(),
    } as Record<string, unknown>,
  }));

  const { error } = await supabase.from("agent_results").insert(rows);

  if (error) {
    // Non-fatal — companies are already inserted
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
 *   3. Fetch raw results from YC API and NewsAPI in parallel.
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
    // 3. Parallel: YC API + NewsAPI
    // ------------------------------------------------------------------
    const [ycResult, newsResult] = await Promise.allSettled([
      searchYcombinator(sector),
      searchNews(searchQuery),
    ]);

    const ycText =
      ycResult.status === "fulfilled"
        ? ycResult.value.rawText
        : `(YC search failed: ${ycResult.reason instanceof Error ? ycResult.reason.message : String(ycResult.reason)})`;

    const ycCount =
      ycResult.status === "fulfilled" ? ycResult.value.results.length : 0;

    const newsText =
      newsResult.status === "fulfilled"
        ? newsResult.value.rawText
        : `(News search failed: ${newsResult.reason instanceof Error ? newsResult.reason.message : String(newsResult.reason)})`;

    const newsCount =
      newsResult.status === "fulfilled" ? newsResult.value.articles.length : 0;

    console.log(`[Sourcing agent] YC results: ${ycCount}, news results: ${newsCount}`);

    // ------------------------------------------------------------------
    // 4. Claude extracts structured companies from raw results
    // ------------------------------------------------------------------
    const { response: llmResponse, modelUsed } = await extractCompaniesWithLlm(
      sector,
      searchQuery,
      ycText,
      newsText,
      maxResults,
      input.approvedByHuman ?? false,
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
    await writeAgentResults(input.taskId, inserted, llmResponse.searchSummary, modelUsed);

    // ------------------------------------------------------------------
    // 8. Mark task completed
    // ------------------------------------------------------------------
    const result: SourcingRunResult = {
      taskId:               input.taskId,
      sector,
      searchQuery,
      totalFoundByLlm:      llmResponse.companies.length,
      newCompaniesInserted: inserted.length,
      skippedDuplicates:    skipped,
      ycResultCount:        ycCount,
      newsResultCount:      newsCount,
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
