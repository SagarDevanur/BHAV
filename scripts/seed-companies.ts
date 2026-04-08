/**
 * scripts/seed-companies.ts
 *
 * Reads BHAV_Target_Companies.xlsx and imports all companies + contacts
 * into Supabase. Safe to run multiple times — skips companies already
 * present (matched by name + sector). Pass --fresh to wipe and re-seed.
 *
 * Usage:
 *   pnpm seed                  # incremental — skips existing records
 *   pnpm seed -- --fresh       # truncates companies/contacts and re-seeds
 *
 * Requires .env.local to be populated (uses SUPABASE_SERVICE_ROLE_KEY).
 */

import path from "path";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import type { InsertCompany, InsertContact } from "@/types/database";

// ---------------------------------------------------------------------------
// Bootstrap env — dotenv is not available in tsx by default; load manually.
// ---------------------------------------------------------------------------
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "❌  Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XLSX_PATH = path.resolve(process.cwd(), "BHAV_Target_Companies.xlsx");
const BATCH_SIZE = 50;

/** Maps each sheet name to the sector value stored in the DB */
const SHEET_TO_SECTOR: Record<string, string> = {
  "Physical AI": "Physical AI",
  "Drones & UAV": "Drones & UAV",
  FinTech: "FinTech",
  "Autonomous EVs": "Autonomous EVs",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExcelRow {
  "#": number;
  "Company Name": string;
  Website: string;
  "Sub-Sector": string;
  "Company Blurb": string;
  "Decision Maker": string;
  Title: string;
  "Last Round / Valuation": string;
  "Company Contact": string;
}

interface ParsedRow {
  company: InsertCompany;
  contact: {
    name: string | null;
    title: string | null;
    email: string | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise website strings — add https:// if no protocol present.
 * Returns null if the input is blank.
 */
function normaliseWebsite(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

/**
 * Split "Series A $45M — ~$150M val" into:
 *   last_round:           "Series A $45M"
 *   estimated_valuation:  "~$150M val"
 *
 * Falls back to storing the whole string in last_round when there is no
 * em-dash separator.
 */
function parseRoundValuation(raw: string | null | undefined): {
  last_round: string | null;
  estimated_valuation: string | null;
} {
  const s = raw?.trim();
  if (!s) return { last_round: null, estimated_valuation: null };

  // Separator is " — " (space + en/em dash + space)
  const sepIndex = s.indexOf(" — ");
  if (sepIndex !== -1) {
    return {
      last_round: s.slice(0, sepIndex).trim() || null,
      estimated_valuation: s.slice(sepIndex + 3).trim() || null,
    };
  }

  return { last_round: s, estimated_valuation: null };
}

/**
 * Parse a single Excel row into a company insert + contact metadata.
 * Returns null if the row has no company name (blank / footer rows).
 */
function parseRow(row: Partial<ExcelRow>, sector: string): ParsedRow | null {
  const name = row["Company Name"]?.toString().trim();
  if (!name) return null;

  const { last_round, estimated_valuation } = parseRoundValuation(
    row["Last Round / Valuation"]
  );

  const company: InsertCompany = {
    name,
    website: normaliseWebsite(row["Website"]),
    sector,
    sub_sector: row["Sub-Sector"]?.toString().trim() || null,
    blurb: row["Company Blurb"]?.toString().trim() || null,
    last_round,
    estimated_valuation,
    despac_score: null,
    status: "sourced",
  };

  const contact = {
    name: row["Decision Maker"]?.toString().trim() || null,
    title: row["Title"]?.toString().trim() || null,
    email: row["Company Contact"]?.toString().trim() || null,
  };

  return { company, contact };
}

/**
 * Insert an array of company rows in batches; returns the inserted rows
 * (with their generated IDs).
 */
async function batchInsertCompanies(
  rows: InsertCompany[]
): Promise<{ id: string; name: string; sector: string | null }[]> {
  const inserted: { id: string; name: string; sector: string | null }[] = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("companies")
      .insert(batch)
      .select("id, name, sector");

    if (error) throw new Error(`Company insert failed: ${error.message}`);
    inserted.push(...(data ?? []));
  }

  return inserted;
}

/**
 * Insert contact rows for all newly inserted companies.
 */
async function batchInsertContacts(contacts: InsertContact[]): Promise<void> {
  const nonEmpty = contacts.filter((c) => c.company_id != null);

  for (let i = 0; i < nonEmpty.length; i += BATCH_SIZE) {
    const batch = nonEmpty.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from("contacts").insert(batch);
    if (error) throw new Error(`Contact insert failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isFresh = process.argv.includes("--fresh");

  console.log("📂  Reading:", XLSX_PATH);
  const wb = XLSX.readFile(XLSX_PATH);

  // Parse all sheets into rows
  const allParsed: ParsedRow[] = [];

  for (const sheetName of wb.SheetNames) {
    const sector = SHEET_TO_SECTOR[sheetName];
    if (!sector) {
      console.warn(`⚠️   Unknown sheet "${sheetName}" — skipping`);
      continue;
    }

    const ws = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Partial<ExcelRow>>(ws, {
      defval: null,
    });

    let sheetCount = 0;
    for (const raw of rawRows) {
      const parsed = parseRow(raw, sector);
      if (parsed) {
        allParsed.push(parsed);
        sheetCount++;
      }
    }

    console.log(`  ✓  ${sheetName}: ${sheetCount} rows`);
  }

  console.log(`\n📊  Total parsed: ${allParsed.length} companies`);

  // --fresh: truncate existing seeded data
  if (isFresh) {
    console.log("\n🗑️   --fresh flag: deleting all sourced records…");
    const { error } = await supabase
      .from("companies")
      .delete()
      .eq("status", "sourced");
    if (error) throw new Error(`Truncate failed: ${error.message}`);
    console.log("  ✓  Cleared");
  }

  // Incremental mode: load existing (name, sector) pairs to skip duplicates
  let existingKeys = new Set<string>();
  if (!isFresh) {
    console.log("\n🔍  Checking for existing records…");
    const { data, error } = await supabase
      .from("companies")
      .select("name, sector");
    if (error) throw new Error(`Fetch existing failed: ${error.message}`);
    existingKeys = new Set((data ?? []).map((r) => `${r.name}||${r.sector}`));
    console.log(`  ✓  ${existingKeys.size} existing companies found`);
  }

  // Filter to only new rows
  const toInsert = allParsed.filter(
    ({ company }) =>
      !existingKeys.has(`${company.name}||${company.sector}`)
  );

  if (toInsert.length === 0) {
    console.log("\n✅  Nothing new to insert. Database is up to date.");
    return;
  }

  console.log(`\n➕  Inserting ${toInsert.length} new companies…`);
  const insertedCompanies = await batchInsertCompanies(
    toInsert.map((r) => r.company)
  );

  // Build a name+sector → id lookup from the just-inserted rows
  const companyIdMap = new Map<string, string>();
  for (const row of insertedCompanies) {
    companyIdMap.set(`${row.name}||${row.sector}`, row.id);
  }

  // Build contact inserts
  const contactInserts: InsertContact[] = [];
  for (const { company, contact } of toInsert) {
    const companyId =
      companyIdMap.get(`${company.name}||${company.sector}`) ?? null;

    // Only insert if there is at least one contact field
    if (contact.name || contact.email) {
      contactInserts.push({
        company_id: companyId,
        name: contact.name,
        title: contact.title,
        email: contact.email,
        linkedin_url: null,
        phone: null,
        enriched_at: null,
      });
    }
  }

  console.log(`➕  Inserting ${contactInserts.length} contacts…`);
  await batchInsertContacts(contactInserts);

  console.log(`\n✅  Done!`);
  console.log(`    Companies inserted: ${insertedCompanies.length}`);
  console.log(`    Contacts inserted:  ${contactInserts.length}`);
}

main().catch((err) => {
  console.error("\n❌ Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
