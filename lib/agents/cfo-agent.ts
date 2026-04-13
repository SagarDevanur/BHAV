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
    const [websiteResult, newsResult, ycResult, sourcingResult] = await Promise.allSettled([
      websiteUrl ? fetchWebsiteMeta(websiteUrl) : Promise.resolve(null),
      companyName ? searchCompanyNews(companyName) : Promise.resolve(null),
      companyName ? checkYcombinator(companyName) : Promise.resolve(null),
      supabase
        .from("agent_results")
        .select("content")
        .eq("company_id", companyId)
        .eq("result_type", "sourcing")
        .order("created_at", { ascending: false })
        .limit(3),
    ]);

    const websiteMeta  = websiteResult.status === "fulfilled" ? websiteResult.value : null;
    const newsItems    = newsResult.status    === "fulfilled" ? newsResult.value    : null;
    const ycData       = ycResult.status      === "fulfilled" ? ycResult.value      : null;
    const sourcingRows = sourcingResult.status === "fulfilled"
      ? (sourcingResult.value.data ?? []).map((r) => r.content)
      : [];

    console.log("[CFO agent] website scraped :", websiteMeta ? "yes" : "no");
    console.log("[CFO agent] news articles   :", newsItems?.length ?? 0);
    console.log("[CFO agent] YC backed       :", ycData ? `yes — batch ${ycData.batch}` : "no");
    console.log("[CFO agent] sourcing intel  :", sourcingRows.length, "row(s)");

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
      website_meta: websiteMeta ?? null,
      // Enrichment: recent news about this company
      news_intel: newsItems && newsItems.length > 0 ? newsItems : null,
      // Enrichment: YC backing
      yc_backed: ycData !== null,
      yc_data:   ycData ?? null,
      // Prior sourcing agent context
      sourcing_intel: sourcingRows.length > 0 ? sourcingRows : null,
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
      despac_score:       parsed.despac_score,
      score_breakdown:    parsed.score_breakdown,
      rationale:          parsed.rationale,
      recommendation:     parsed.recommendation,
      confidence:         parsed.confidence,
      yc_backed:          ycData !== null,
      yc_batch:           ycData?.batch ?? null,
      news_articles_used: newsItems?.length ?? 0,
      website_scraped:    websiteMeta !== null,
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
