/**
 * CFO Agent — financial due diligence and deSPAC scoring.
 *
 * Input:  AgentInput (company fields arrive via input.payload, taskId via input.taskId)
 * Output: CfoRunResult containing despac_score, score_breakdown, recommendation, reasoning
 *
 * Pre-screening (runs before any enrichment or Claude call):
 *   - Checks SEC EDGAR for 10-K filings (already public) or S-1 filings (filing to go public).
 *   - If found: sets despac_score = 0, status = "rejected", skips Claude entirely.
 *   - EDGAR failure is non-fatal — scoring proceeds if the check times out or errors.
 *
 * Enrichment sources (all non-fatal — scoring continues if any fail):
 *   1. Company website  — title, meta description, revenue/funding/team signals (5 s timeout)
 *   2. Google News API  — recent funding/revenue articles for this company (5 s timeout)
 *   3. YCombinator API  — confirms YC backing and batch; adds +5 bonus to redemption_risk
 *
 * Side effects:
 *   - Updates agent_tasks row (running → completed | failed)
 *   - Updates companies.despac_score in Supabase
 *   - Writes a scored result row to agent_results (result_type = "score")
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { AGENT_PROMPTS } from "./prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

// ---------------------------------------------------------------------------
// LLM client
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ---------------------------------------------------------------------------
// Types — public
// ---------------------------------------------------------------------------

export interface CfoScoreBreakdown {
  revenue_fit: number;
  valuation_band: number;
  sector_alignment: number;
  redemption_risk: number;
}

export interface CfoRationale {
  revenue_fit: string;
  valuation_band: string;
  sector_alignment: string;
  redemption_risk: string;
}

export interface CfoRunResult {
  taskId: string;
  companyId: string;
  despac_score: number;
  score_breakdown: CfoScoreBreakdown;
  rationale: CfoRationale;
  recommendation: "approve" | "review" | "reject";
  confidence: "low" | "medium" | "high";
  modelUsed: string;
}

// ---------------------------------------------------------------------------
// Types — internal
// ---------------------------------------------------------------------------

interface LlmCfoResponse {
  companyId: string;
  despac_score: number;
  score_breakdown: CfoScoreBreakdown;
  rationale: CfoRationale;
  recommendation: "approve" | "review" | "reject";
  confidence: "low" | "medium" | "high";
}

interface WebsiteMeta {
  title: string | null;
  description: string | null;
  /** Revenue mentions found in page text, e.g. "$12M ARR" */
  revenueSignals: string[];
  /** Funding mentions found in page text, e.g. "raised Series B" */
  fundingSignals: string[];
  /** Team-size mentions found in page text, e.g. "200 employees" */
  teamSignals: string[];
}

interface NewsItem {
  title: string;
  description: string | null;
  publishedAt: string;
  source: string;
}

interface YcData {
  name: string;
  batch: string;
  website: string | null;
  description: string | null;
}

interface LinkedInData {
  /** Employee range as shown on LinkedIn, e.g. "201-500 employees" */
  employeeRange: string | null;
  foundingYear: string | null;
  industry: string | null;
  description: string | null;
}

interface CrunchbaseData {
  /** Total funding summary extracted from page meta, e.g. "$45M" */
  fundingSummary: string | null;
  /** Last known funding type, e.g. "Series B" */
  lastFundingType: string | null;
  description: string | null;
}

interface Inc42Data {
  /** Article titles matching the company from Inc42 search results */
  articles: Array<{ title: string; date: string | null }>;
}

interface ProductHuntData {
  /** Products found for this company on ProductHunt */
  products: Array<{ name: string; tagline: string | null; votesCount: string | null }>;
}

interface EdgarPreScreenResult {
  /** true = company has public SEC filings → ineligible for deSPAC */
  isPublic: boolean;
  /** Which form triggered the flag ("10-K" | "S-1"), or null if private/unknown */
  formType: string | null;
  /** Entity name as it appears on EDGAR, or null */
  entityName: string | null;
  /** Human-readable reason for the flag */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Pre-screening: SEC EDGAR public-company check
// ---------------------------------------------------------------------------

/**
 * Searches SEC EDGAR for 10-K and S-1 filings matching the company name.
 *
 *  - 10-K present → company already files with the SEC as a public company → ineligible
 *  - S-1 present  → company is pursuing a traditional IPO → ineligible for deSPAC
 *
 * Both searches run in parallel with a shared 5-second AbortController timeout.
 * Returns { isPublic: false } on any network error so scoring always proceeds
 * when EDGAR is unreachable.
 */
async function checkEdgarPublicListing(
  companyName: string,
): Promise<EdgarPreScreenResult> {
  const EDGAR_BASE = "https://efts.sec.gov/LATEST/search-index";
  const USER_AGENT = "BHAV-Acquisition-Corp contact@bhav.io";

  const encoded = encodeURIComponent(`"${companyName}"`);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  const fetchForm = async (forms: string) => {
    const url =
      `${EDGAR_BASE}?q=${encoded}&forms=${forms}` +
      `&hits.hits._source=entity_name,form_type,file_date` +
      `&from=0&size=1`;

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept":     "application/json",
      },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      hits?: {
        hits?: Array<{
          _source?: { entity_name?: string; form_type?: string; file_date?: string };
        }>;
      };
    };

    const hit = json?.hits?.hits?.[0]?._source;
    return hit ?? null;
  };

  try {
    const [tenK, s1] = await Promise.all([
      fetchForm("10-K"),
      fetchForm("S-1"),
    ]);

    if (tenK) {
      return {
        isPublic:   true,
        formType:   "10-K",
        entityName: tenK.entity_name ?? null,
        reason:     `10-K filing found on SEC EDGAR (filed by "${tenK.entity_name ?? companyName}") — company is already publicly listed`,
      };
    }

    if (s1) {
      return {
        isPublic:   true,
        formType:   "S-1",
        entityName: s1.entity_name ?? null,
        reason:     `S-1 registration statement found on SEC EDGAR (filed by "${s1.entity_name ?? companyName}") — company is pursuing a traditional IPO`,
      };
    }

    return { isPublic: false, formType: null, entityName: null, reason: null };
  } catch {
    // Network error or timeout — treat as private so scoring is not blocked
    return { isPublic: false, formType: null, entityName: null, reason: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Enrichment: company website scrape
// ---------------------------------------------------------------------------

/**
 * Fetches the company's homepage and extracts:
 *   - Page title and meta description for business context
 *   - Revenue, funding, and team-size signal mentions from body text
 *
 * Uses a 5-second AbortController timeout. Returns null on any error.
 */
async function fetchWebsiteMeta(websiteUrl: string): Promise<WebsiteMeta | null> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  try {
    const url = /^https?:\/\//i.test(websiteUrl)
      ? websiteUrl
      : `https://${websiteUrl}`;

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BHAV-Research-Bot/1.0)" },
    });

    if (!res.ok) return null;

    const html = await res.text();

    // Title
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    const title       = titleMatch ? titleMatch[1].trim() : null;

    // Meta description — handle both attribute orderings
    const descMatch =
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i.exec(html);
    const description = descMatch ? descMatch[1].trim() : null;

    // Strip tags for text signal extraction
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    const revenueSignals = Array.from(
      new Set(
        (text.match(/\$[\d,.]+\s*[MBK]?\s*(?:million|billion|ARR|MRR|revenue|recurring)/gi) ?? [])
          .slice(0, 5)
      ),
    );

    const fundingSignals = Array.from(
      new Set(
        (text.match(/(?:Series [A-E]\b|raised|Seed round|funding round|investment)[^.]{0,100}/gi) ?? [])
          .slice(0, 5)
          .map((s) => s.trim()),
      ),
    );

    const teamSignals = Array.from(
      new Set(
        (text.match(/\d+\s*\+?\s*(?:employees|team members|people|staff)/gi) ?? []).slice(0, 3),
      ),
    );

    return { title, description, revenueSignals, fundingSignals, teamSignals };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Enrichment: Google News search
// ---------------------------------------------------------------------------

/**
 * Searches NewsAPI for recent articles about the company mentioning
 * funding, revenue, or fundraising rounds. Returns up to 5 articles.
 *
 * Requires GOOGLE_NEWS_API_KEY — returns null when key is absent.
 * Uses a 5-second AbortController timeout.
 */
async function searchCompanyNews(companyName: string): Promise<NewsItem[] | null> {
  const apiKey = config.googleNews.apiKey;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  try {
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const from = twoYearsAgo.toISOString().slice(0, 10);

    const query = encodeURIComponent(`"${companyName}" funding OR revenue OR Series`);
    const url   =
      `https://newsapi.org/v2/everything` +
      `?q=${query}&from=${from}&language=en&pageSize=5&sortBy=publishedAt&apiKey=${apiKey}`;

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      articles?: Array<{
        title?: string;
        description?: string;
        publishedAt?: string;
        source?: { name?: string };
      }>;
    };

    return (json.articles ?? []).slice(0, 5).map((a) => ({
      title:       String(a.title        ?? ""),
      description: a.description ? String(a.description) : null,
      publishedAt: String(a.publishedAt  ?? ""),
      source:      String(a.source?.name ?? ""),
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Enrichment: YCombinator API
// ---------------------------------------------------------------------------

/**
 * Checks whether the company is YC-backed by querying the public YC API.
 * Returns the matching company record on an exact name match (case-insensitive),
 * or the first result as a best-effort match, or null if nothing is found.
 *
 * Uses a 5-second AbortController timeout.
 */
async function checkYcombinator(companyName: string): Promise<YcData | null> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  try {
    const query = encodeURIComponent(companyName);
    const url   = `https://api.ycombinator.com/v0.1/companies?q=${query}`;

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      companies?: Array<{
        name?: string;
        batch?: string;
        website?: string;
        one_liner?: string;
        long_description?: string;
      }>;
    };

    const companies = json.companies ?? [];
    if (companies.length === 0) return null;

    const normalised = companyName.toLowerCase().trim();
    const exact       = companies.find(
      (c) => (c.name ?? "").toLowerCase().trim() === normalised,
    );
    const match = exact ?? companies[0];

    return {
      name:        String(match.name    ?? ""),
      batch:       String(match.batch   ?? ""),
      website:     match.website  ? String(match.website)      : null,
      description: match.one_liner ? String(match.one_liner)   : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Helper: company name → URL slug
// ---------------------------------------------------------------------------

/**
 * Converts a company name to a lowercase hyphenated slug suitable for use
 * in LinkedIn, Crunchbase, and similar URL paths.
 * e.g. "Acme Corp." → "acme-corp"
 */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// ---------------------------------------------------------------------------
// Enrichment: LinkedIn company page
// ---------------------------------------------------------------------------

/**
 * Fetches the LinkedIn company page and extracts employee range, founding
 * year, industry, and description from Open Graph meta tags and JSON-LD
 * structured data rendered server-side.
 *
 * Note: LinkedIn's bot-detection (HTTP 999) or login-wall redirect may
 * prevent data extraction. All fields default to null on any failure.
 * Uses a 5-second AbortController timeout.
 */
async function fetchLinkedInData(companyName: string): Promise<LinkedInData | null> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  try {
    const slug = toSlug(companyName);
    const url  = `https://www.linkedin.com/company/${slug}`;

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        "User-Agent":      "Mozilla/5.0 (compatible; BHAV-Research-Bot/1.0)",
        "Accept":          "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // LinkedIn returns 999 for bot requests; treat any non-2xx as no data
    if (!res.ok) return null;

    const html = await res.text();

    // JSON-LD structured data — LinkedIn renders Organization schema server-side
    const ldMatch = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let ldJson: Record<string, unknown> | null = null;
    let m: RegExpExecArray | null;
    while ((m = ldMatch.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(m[1]) as Record<string, unknown>;
        if (parsed["@type"] === "Organization" || parsed["@type"] === "Corporation") {
          ldJson = parsed;
          break;
        }
      } catch { /* malformed JSON-LD — skip */ }
    }

    // Employee range — appears in JSON-LD as numberOfEmployees or in og:description
    const empFromLd = ldJson?.numberOfEmployees;
    const empRange =
      typeof empFromLd === "object" && empFromLd !== null
        ? String((empFromLd as Record<string, unknown>).value ?? "")
        : typeof empFromLd === "string" || typeof empFromLd === "number"
        ? String(empFromLd)
        : (html.match(/\b(\d[\d,]*(?:\s*[-–]\s*\d[\d,]*)?)\s*employees\b/i)?.[1] ?? null);

    // Founding year — from JSON-LD foundingDate or text pattern
    const foundingRaw = String(ldJson?.foundingDate ?? "");
    const foundingYear =
      foundingRaw
        ? foundingRaw.slice(0, 4)
        : (html.match(/[Ff]ounded(?:\s+in)?\s+(\d{4})/)?.[1] ?? null);

    // Industry — JSON-LD industry field or text pattern
    const industry =
      ldJson?.industry ? String(ldJson.industry) :
      (html.match(/<dt[^>]*>[Ii]ndustry<\/dt>\s*<dd[^>]*>([^<]+)<\/dd>/)?.[1]?.trim() ?? null);

    // Description — og:description preferred, JSON-LD description fallback
    const ogDesc =
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i.exec(html)?.[1] ??
      null;
    const description = ogDesc ?? (ldJson?.description ? String(ldJson.description) : null);

    if (!empRange && !foundingYear && !industry && !description) return null;

    return {
      employeeRange: empRange ? String(empRange).trim() : null,
      foundingYear:  foundingYear ?? null,
      industry:      industry ?? null,
      description:   description ? description.slice(0, 300) : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Enrichment: Crunchbase organization page
// ---------------------------------------------------------------------------

/**
 * Fetches the Crunchbase organization page and extracts funding summary,
 * last funding type, and company description from Open Graph meta tags
 * and page title (server-rendered for SEO).
 *
 * Note: Crunchbase is a React SPA; detailed funding tables require JS
 * rendering. This fetch captures only what Crunchbase renders in HTML
 * for SEO purposes, primarily the og:description and title.
 * Uses a 5-second AbortController timeout.
 */
async function fetchCrunchbaseData(companyName: string): Promise<CrunchbaseData | null> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  try {
    const slug = toSlug(companyName);
    const url  = `https://www.crunchbase.com/organization/${slug}`;

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BHAV-Research-Bot/1.0)",
        "Accept":     "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) return null;

    const html = await res.text();

    // og:description — Crunchbase often includes funding totals here, e.g.
    // "Total Equity Funding Amount - $45M | Raised a Series B"
    const ogDesc =
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,})["']/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']{10,})["'][^>]+property=["']og:description["']/i.exec(html)?.[1] ??
      null;

    if (!ogDesc) return null;

    // Extract total funding amount, e.g. "$45M", "$1.2B"
    const fundingMatch = ogDesc.match(/\$[\d,.]+\s*[MBK]?(?:\s+(?:million|billion))?/i);
    const fundingSummary = fundingMatch ? fundingMatch[0].trim() : null;

    // Extract last funding type
    const roundMatch = ogDesc.match(
      /\b(Series [A-Z]\+?|Seed|Pre-Seed|Series A|Series B|Series C|Series D|Series E|Series F|Venture|Growth Equity|Private Equity|IPO|SPAC|Debt Financing)\b/i
    );
    const lastFundingType = roundMatch ? roundMatch[1] : null;

    return {
      fundingSummary:  fundingSummary,
      lastFundingType: lastFundingType,
      description:     ogDesc.slice(0, 300),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Enrichment: Inc42 search (Indian startup funding news)
// ---------------------------------------------------------------------------

/**
 * Searches Inc42 (a leading Indian startup media site) for news articles
 * mentioning the company. Inc42 is WordPress-based and server-renders search
 * results, making article titles reliably extractable.
 *
 * Useful for identifying Indian startups in FinTech, Physical AI, and EVs
 * that may not appear in US news sources.
 * Uses a 5-second AbortController timeout.
 */
async function searchInc42(companyName: string): Promise<Inc42Data | null> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  try {
    const query = encodeURIComponent(companyName);
    const url   = `https://inc42.com/?s=${query}`;

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BHAV-Research-Bot/1.0)" },
    });

    if (!res.ok) return null;

    const html = await res.text();

    // WordPress article titles appear in <h2 class="entry-title"> or <h3> within <article> tags
    const titleRegex = /<(?:h2|h3)[^>]*class=["'][^"']*(?:entry-title|post-title)[^"']*["'][^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi;
    const articles: Array<{ title: string; date: string | null }> = [];

    // Also try date patterns near each title
    const dateRegex = /<time[^>]*datetime=["']([^"']+)["']/i;

    let titleMatch: RegExpExecArray | null;
    while ((titleMatch = titleRegex.exec(html)) !== null && articles.length < 5) {
      const title = titleMatch[1].trim();
      // Only include if title mentions the company name (case-insensitive)
      if (title.toLowerCase().includes(companyName.toLowerCase().split(" ")[0].toLowerCase())) {
        const dateMatch = dateRegex.exec(html.slice(titleMatch.index, titleMatch.index + 500));
        articles.push({
          title,
          date: dateMatch ? dateMatch[1].slice(0, 10) : null,
        });
      }
    }

    if (articles.length === 0) return null;
    return { articles };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Enrichment: ProductHunt launch check
// ---------------------------------------------------------------------------

/**
 * Searches ProductHunt for products matching the company name.
 * ProductHunt is a Next.js app that embeds page data in a
 * <script id="__NEXT_DATA__"> tag — this is parsed to extract product
 * names, taglines, and vote counts from search results.
 *
 * A ProductHunt listing confirms the company is an active private startup
 * with a consumer/developer-facing product. Recent high-vote products
 * indicate strong market traction.
 * Uses a 5-second AbortController timeout.
 */
async function searchProductHunt(companyName: string): Promise<ProductHuntData | null> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 5_000);

  try {
    const query = encodeURIComponent(companyName);
    const url   = `https://www.producthunt.com/search?q=${query}`;

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BHAV-Research-Bot/1.0)",
        "Accept":     "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) return null;

    const html = await res.text();

    // ProductHunt (Next.js) embeds all page data in __NEXT_DATA__
    const nextDataMatch = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (!nextDataMatch) return null;

    let nextData: Record<string, unknown>;
    try {
      nextData = JSON.parse(nextDataMatch[1]) as Record<string, unknown>;
    } catch {
      return null;
    }

    // Navigate the Next.js page props tree to find search results
    // Path varies by PH version; try common locations
    const pageProps =
      (nextData?.props as Record<string, unknown> | undefined)?.pageProps as
        Record<string, unknown> | undefined;

    const posts =
      (pageProps?.posts as unknown[] | undefined) ??
      (pageProps?.searchResults as unknown[] | undefined) ??
      ((pageProps?.data as Record<string, unknown> | undefined)?.posts as unknown[] | undefined) ??
      [];

    if (!Array.isArray(posts) || posts.length === 0) return null;

    const products = (posts as Record<string, unknown>[])
      .slice(0, 5)
      .map((p) => ({
        name:       String(p.name ?? p.slug ?? ""),
        tagline:    p.tagline ? String(p.tagline) : null,
        votesCount: p.votesCount != null ? String(p.votesCount) : null,
      }))
      .filter((p) => p.name);

    if (products.length === 0) return null;
    return { products };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Supabase: fetch company website URL
// ---------------------------------------------------------------------------

/**
 * Fetches just the website field for a company so the CFO agent can scrape it.
 * Returns null if the company has no website or on any DB error.
 */
async function fetchCompanyWebsite(companyId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("companies")
    .select("website")
    .eq("id", companyId)
    .single();

  return (data as { website?: string | null } | null)?.website ?? null;
}

// ---------------------------------------------------------------------------
// LLM response validation
// ---------------------------------------------------------------------------

const VALID_RECOMMENDATIONS = new Set(["approve", "review", "reject"]);
const VALID_CONFIDENCE       = new Set(["low", "medium", "high"]);

function validateLlmResponse(raw: unknown): LlmCfoResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("CFO agent response is not a JSON object");
  }

  const r = raw as Record<string, unknown>;

  const score = Number(r.despac_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`CFO agent returned invalid despac_score: ${String(r.despac_score)}`);
  }

  const breakdown = r.score_breakdown as Record<string, unknown> | undefined;
  if (!breakdown || typeof breakdown !== "object") {
    throw new Error("CFO agent response missing score_breakdown");
  }

  const rationale = r.rationale as Record<string, unknown> | undefined;
  if (!rationale || typeof rationale !== "object") {
    throw new Error("CFO agent response missing rationale");
  }

  if (!VALID_RECOMMENDATIONS.has(String(r.recommendation))) {
    throw new Error(`CFO agent returned invalid recommendation: ${String(r.recommendation)}`);
  }

  const confidence = VALID_CONFIDENCE.has(String(r.confidence))
    ? (r.confidence as "low" | "medium" | "high")
    : "low";

  return {
    companyId:    String(r.companyId ?? ""),
    despac_score: Math.round(score),
    score_breakdown: {
      revenue_fit:      Number(breakdown.revenue_fit      ?? 0),
      valuation_band:   Number(breakdown.valuation_band   ?? 0),
      sector_alignment: Number(breakdown.sector_alignment ?? 0),
      redemption_risk:  Number(breakdown.redemption_risk  ?? 0),
    },
    rationale: {
      revenue_fit:      String(rationale.revenue_fit      ?? ""),
      valuation_band:   String(rationale.valuation_band   ?? ""),
      sector_alignment: String(rationale.sector_alignment ?? ""),
      redemption_risk:  String(rationale.redemption_risk  ?? ""),
    },
    recommendation: r.recommendation as "approve" | "review" | "reject",
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Core agent function
// ---------------------------------------------------------------------------

/**
 * Runs the CFO agent against a company record.
 *
 * Flow:
 *   1. Mark agent_tasks row as running.
 *   2. Pre-screen: check SEC EDGAR for 10-K / S-1 filings.
 *      → If public: reject immediately (despac_score = 0, status = "rejected"), return early.
 *      → If private (or EDGAR unavailable): continue.
 *   3. Fetch company website URL from Supabase.
 *   4. Run enrichment in parallel: website scrape + Google News + YC check + sourcing intel.
 *   5. Build enriched prompt: company fields + website meta + news + YC data + sourcing intel.
 *   6. Call Claude and parse the structured JSON response.
 *   7. Update companies.despac_score in Supabase.
 *   8. Write a scored row to agent_results.
 *   9. Mark agent_tasks row as completed (or failed on any error).
 *  10. Return the structured CfoRunResult.
 */
export async function runCfoAgent(input: AgentInput): Promise<CfoRunResult> {
  const supabase  = createAdminClient();
  const payload   = input.payload ?? {};
  const companyId = input.companyId ?? String(payload.companyId ?? "");

  // ------------------------------------------------------------------
  // Startup diagnostics
  // ------------------------------------------------------------------
  console.log("[CFO agent] ── START ──────────────────────────────────────");
  console.log("[CFO agent] taskId           :", input.taskId);
  console.log("[CFO agent] resolved companyId:", companyId || "(EMPTY — will throw)");
  console.log("[CFO agent] supabase URL     :", process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "(NOT SET — DB calls will fail)");
  console.log("[CFO agent] service key set  :", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY));
  console.log("[CFO agent] news API set     :", Boolean(config.googleNews.apiKey));

  if (!companyId) throw new Error("CFO agent requires a companyId");

  // ------------------------------------------------------------------
  // 1. Mark task running
  // ------------------------------------------------------------------
  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", input.taskId);

  try {
    const companyName = String(payload.name ?? "");

    // ------------------------------------------------------------------
    // 2. Pre-screen: SEC EDGAR public-company check
    // ------------------------------------------------------------------
    const edgarScreen = companyName
      ? await checkEdgarPublicListing(companyName)
      : { isPublic: false, formType: null, entityName: null, reason: null };

    if (edgarScreen.isPublic) {
      console.log(`[CFO agent] ${companyName} — PUBLIC (skip): ${edgarScreen.reason ?? ""}`);

      const publicResultContent: Record<string, unknown> = {
        despac_score:    0,
        score_breakdown: { revenue_fit: 0, valuation_band: 0, sector_alignment: 0, redemption_risk: 0 },
        rationale: {
          revenue_fit:      "Ineligible — company already has SEC public filings.",
          valuation_band:   "Ineligible — company already has SEC public filings.",
          sector_alignment: "Ineligible — company already has SEC public filings.",
          redemption_risk:  "Ineligible — company already has SEC public filings.",
        },
        recommendation:  "reject",
        confidence:      "high",
        skipped_reason:  edgarScreen.reason,
        edgar_form_type: edgarScreen.formType,
        edgar_entity:    edgarScreen.entityName,
        modelUsed:       "edgar-pre-screen",
      };

      // Update companies table — score 0, rejected
      await supabase
        .from("companies")
        .update({ despac_score: 0, status: "rejected", updated_at: new Date().toISOString() })
        .eq("id", companyId);

      // Write agent_results note
      await supabase.from("agent_results").insert({
        task_id:     input.taskId,
        company_id:  companyId,
        agent_name:  "cfo",
        result_type: "score",
        content:     publicResultContent,
      });

      // Mark task completed
      await supabase
        .from("agent_tasks")
        .update({ status: "completed", output: publicResultContent, completed_at: new Date().toISOString() })
        .eq("id", input.taskId);

      return {
        taskId:          input.taskId,
        companyId,
        despac_score:    0,
        score_breakdown: { revenue_fit: 0, valuation_band: 0, sector_alignment: 0, redemption_risk: 0 },
        rationale: {
          revenue_fit:      "Ineligible — company already has SEC public filings.",
          valuation_band:   "Ineligible — company already has SEC public filings.",
          sector_alignment: "Ineligible — company already has SEC public filings.",
          redemption_risk:  "Ineligible — company already has SEC public filings.",
        },
        recommendation: "reject",
        confidence:     "high",
        modelUsed:      "edgar-pre-screen",
      };
    }

    console.log(`[CFO agent] ${companyName} — PRIVATE (score)`);

    // ------------------------------------------------------------------
    // 3. Fetch company website URL
    // ------------------------------------------------------------------
    const websiteUrl = String(payload.website ?? "") || await fetchCompanyWebsite(companyId);

    // ------------------------------------------------------------------
    // 4. Parallel enrichment + sourcing intel fetch
    // ------------------------------------------------------------------
    const [
      websiteResult,
      newsResult,
      ycResult,
      linkedinResult,
      crunchbaseResult,
      inc42Result,
      productHuntResult,
      sourcingResult,
    ] = await Promise.allSettled([
      websiteUrl  ? fetchWebsiteMeta(websiteUrl)        : Promise.resolve(null),
      companyName ? searchCompanyNews(companyName)       : Promise.resolve(null),
      companyName ? checkYcombinator(companyName)        : Promise.resolve(null),
      companyName ? fetchLinkedInData(companyName)       : Promise.resolve(null),
      companyName ? fetchCrunchbaseData(companyName)     : Promise.resolve(null),
      companyName ? searchInc42(companyName)             : Promise.resolve(null),
      companyName ? searchProductHunt(companyName)       : Promise.resolve(null),
      supabase
        .from("agent_results")
        .select("content")
        .eq("company_id", companyId)
        .eq("result_type", "sourcing")
        .order("created_at", { ascending: false })
        .limit(3),
    ]);

    const websiteMeta    = websiteResult.status     === "fulfilled" ? websiteResult.value     : null;
    const newsItems      = newsResult.status        === "fulfilled" ? newsResult.value        : null;
    const ycData         = ycResult.status          === "fulfilled" ? ycResult.value          : null;
    const linkedinData   = linkedinResult.status    === "fulfilled" ? linkedinResult.value    : null;
    const crunchbaseData = crunchbaseResult.status  === "fulfilled" ? crunchbaseResult.value  : null;
    const inc42Data      = inc42Result.status       === "fulfilled" ? inc42Result.value       : null;
    const productHuntData = productHuntResult.status === "fulfilled" ? productHuntResult.value : null;
    const sourcingRows   = sourcingResult.status    === "fulfilled"
      ? (sourcingResult.value.data ?? []).map((r) => r.content)
      : [];

    console.log("[CFO agent] website scraped  :", websiteMeta    ? "yes" : "no");
    console.log("[CFO agent] news articles    :", newsItems?.length ?? 0);
    console.log("[CFO agent] YC backed        :", ycData         ? `yes — batch ${ycData.batch}` : "no");
    console.log("[CFO agent] LinkedIn         :", linkedinData   ? `yes — ${linkedinData.employeeRange ?? "no employee range"}` : "no");
    console.log("[CFO agent] Crunchbase       :", crunchbaseData ? `yes — ${crunchbaseData.fundingSummary ?? "no funding"}` : "no");
    console.log("[CFO agent] Inc42 articles   :", inc42Data?.articles.length ?? 0);
    console.log("[CFO agent] ProductHunt      :", productHuntData ? `yes — ${productHuntData.products.length} product(s)` : "no");
    console.log("[CFO agent] sourcing intel   :", sourcingRows.length, "row(s)");

    // ------------------------------------------------------------------
    // 5. Build enriched user message
    // ------------------------------------------------------------------
    const userMessage = JSON.stringify({
      companyId,
      name:                payload.name                ?? null,
      sector:              payload.sector              ?? null,
      sub_sector:          payload.sub_sector          ?? null,
      estimated_revenue:   payload.estimated_revenue   ?? null,
      estimated_valuation: payload.estimated_valuation ?? null,
      last_round:          payload.last_round          ?? null,
      blurb:               payload.blurb               ?? null,
      approvedByHuman:     input.approvedByHuman       ?? false,
      // Enrichment: website signals
      website_meta:     websiteMeta ?? null,
      // Enrichment: recent news about this company
      news_intel:       newsItems && newsItems.length > 0 ? newsItems : null,
      // Enrichment: YC backing
      yc_backed:        ycData !== null,
      yc_data:          ycData ?? null,
      // Enrichment: LinkedIn company page (employee range, founding year, industry)
      linkedin_data:    linkedinData ?? null,
      // Enrichment: Crunchbase organization page (funding summary, last round type)
      crunchbase_data:  crunchbaseData ?? null,
      // Enrichment: Inc42 search results (Indian startup funding news)
      inc42_articles:   inc42Data && inc42Data.articles.length > 0 ? inc42Data.articles : null,
      // Enrichment: ProductHunt launches (confirms active private startup with product)
      producthunt_data: productHuntData ?? null,
      // Prior sourcing agent context
      sourcing_intel:   sourcingRows.length > 0 ? sourcingRows : null,
    });

    // ------------------------------------------------------------------
    // 6. Call Claude
    // ------------------------------------------------------------------
    const message = await anthropic.messages.create({
      model:      config.anthropic.model,
      max_tokens: 1024,
      system:     AGENT_PROMPTS.cfo,
      messages:   [{ role: "user", content: userMessage }],
    });

    if (message.content[0].type !== "text") {
      throw new Error("Claude returned a non-text content block");
    }

    const responseText = message.content[0].text;
    const modelUsed    = config.anthropic.model;

    console.log("[CFO agent] raw Claude response (first 600 chars):");
    console.log(responseText.slice(0, 600));

    const jsonText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    console.log("[CFO agent] cleaned JSON (first 400 chars):");
    console.log(jsonText.slice(0, 400));

    let parsed: LlmCfoResponse;
    try {
      parsed = validateLlmResponse(JSON.parse(jsonText));
    } catch (parseErr) {
      console.error("[CFO agent] JSON parse/validate failed:", parseErr);
      throw new Error(
        `CFO agent received invalid JSON from ${modelUsed}: ${jsonText.slice(0, 400)}`
      );
    }

    console.log("[CFO agent] parsed score   :", parsed.despac_score);
    console.log("[CFO agent] recommendation :", parsed.recommendation);
    console.log("[CFO agent] confidence     :", parsed.confidence);

    // ------------------------------------------------------------------
    // 7. Update companies.despac_score
    // ------------------------------------------------------------------
    console.log(`[CFO agent] updating companies SET despac_score=${parsed.despac_score} WHERE id=${companyId}`);

    const { data: updatedRows, error: scoreUpdateError } = await supabase
      .from("companies")
      .update({
        despac_score: parsed.despac_score,
        status:       "reviewed",
        updated_at:   new Date().toISOString(),
      })
      .eq("id", companyId)
      .select("id");

    console.log("[CFO agent] Supabase update result — error  :", scoreUpdateError ?? "none");
    console.log("[CFO agent] Supabase update result — rows   :", JSON.stringify(updatedRows));

    if (scoreUpdateError) {
      throw new Error(
        `[CFO agent] Supabase error updating companies for ${companyId}: ${scoreUpdateError.message}`
      );
    }

    if (!updatedRows || updatedRows.length === 0) {
      throw new Error(
        `[CFO agent] companies UPDATE matched 0 rows — companyId "${companyId}" not found. ` +
        `Verify this companyId exists in the companies table.`
      );
    }

    console.log(
      `[CFO agent] ✓ companies.despac_score = ${parsed.despac_score}, status = "reviewed" for ${companyId}`
    );

    // ------------------------------------------------------------------
    // 8. Write to agent_results
    // ------------------------------------------------------------------
    const resultContent: Record<string, unknown> = {
      despac_score:          parsed.despac_score,
      score_breakdown:       parsed.score_breakdown,
      rationale:             parsed.rationale,
      recommendation:        parsed.recommendation,
      confidence:            parsed.confidence,
      yc_backed:             ycData !== null,
      yc_batch:              ycData?.batch ?? null,
      news_articles_used:    newsItems?.length ?? 0,
      website_scraped:       websiteMeta !== null,
      linkedin_scraped:      linkedinData !== null,
      crunchbase_scraped:    crunchbaseData !== null,
      inc42_articles_found:  inc42Data?.articles.length ?? 0,
      producthunt_found:     productHuntData !== null,
      modelUsed,
    };

    const { error: resultError } = await supabase.from("agent_results").insert({
      task_id:     input.taskId,
      company_id:  companyId,
      agent_name:  "cfo",
      result_type: "score",
      content:     resultContent,
    });

    if (resultError) {
      console.error("[CFO agent] Failed to insert agent_results row:", resultError.message);
    }

    // ------------------------------------------------------------------
    // 9. Mark task completed
    // ------------------------------------------------------------------
    await supabase
      .from("agent_tasks")
      .update({
        status:       "completed",
        output:       resultContent,
        completed_at: new Date().toISOString(),
      })
      .eq("id", input.taskId);

    // ------------------------------------------------------------------
    // 10. Return structured result
    // ------------------------------------------------------------------
    return {
      taskId:          input.taskId,
      companyId,
      despac_score:    parsed.despac_score,
      score_breakdown: parsed.score_breakdown,
      rationale:       parsed.rationale,
      recommendation:  parsed.recommendation,
      confidence:      parsed.confidence,
      modelUsed,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await supabase
      .from("agent_tasks")
      .update({ status: "failed", error, completed_at: new Date().toISOString() })
      .eq("id", input.taskId);
    throw err;
  }
}
