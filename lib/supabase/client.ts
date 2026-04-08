// Browser-side Supabase client. Safe to use in Client Components.
// Uses the public anon key only — Row Level Security is enforced by Supabase.
import { createBrowserClient } from "@supabase/ssr";

// These two vars are NEXT_PUBLIC_* so they are safe to read in the browser.
// We cannot import lib/config.ts here because it references server-only vars
// and would be bundled into the client chunk.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
