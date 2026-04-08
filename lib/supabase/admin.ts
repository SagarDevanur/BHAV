// Admin Supabase client — uses the service role key, bypasses Row Level Security.
// NEVER import this from any Client Component or any file that could be bundled
// for the browser. Server-only: API routes, agent workers, migration scripts.
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { config } from "@/lib/config";

/**
 * Creates a Supabase admin client with full database access (no RLS).
 * Use only for agent workers and privileged API routes.
 * Each call returns a new client instance — do not cache across requests.
 */
export function createAdminClient() {
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
