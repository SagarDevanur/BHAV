// GET /api/companies — list companies with optional status filter
// POST /api/companies — create a new company record
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InsertCompany } from "@/types/database";

const createSchema = z.object({
  name: z.string().min(1),
  website: z.string().url().optional(),
  sector: z.string().optional(),
  sub_sector: z.string().optional(),
  blurb: z.string().optional(),
  last_round: z.string().optional(),
  estimated_valuation: z.string().optional(),
  status: z
    .enum(["sourced", "scoring", "reviewed", "approved", "rejected", "loi_sent"])
    .default("sourced"),
});

export async function GET(request: Request) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  const supabase = createAdminClient();

  try {
    let query = supabase
      .from("companies")
      .select("*")
      .order("created_at", { ascending: false });

    if (status) {
      query = query.eq("status", status);
    }

    const { data, error } = await query;

    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const supabase = createAdminClient();

  try {
    const insert: InsertCompany = {
      name: parsed.data.name,
      status: parsed.data.status,
      website: parsed.data.website ?? null,
      sector: parsed.data.sector ?? null,
      sub_sector: parsed.data.sub_sector ?? null,
      blurb: parsed.data.blurb ?? null,
      last_round: parsed.data.last_round ?? null,
      estimated_valuation: parsed.data.estimated_valuation ?? null,
      despac_score: null,
    };

    const { data, error } = await supabase
      .from("companies")
      .insert(insert)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
