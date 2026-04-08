// Server-side Supabase client. Use in Server Components and API routes only.
// This file must never be imported from Client Components.
import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { config } from "@/lib/config";

/**
 * Creates a Supabase client scoped to the current request's cookie session.
 * Uses the anon key — RLS is enforced. For admin/service operations use admin.ts.
 *
 * Cookie writes are wrapped in try/catch because Server Components cannot
 * set cookies; middleware handles session refresh in that case.
 */
export function createClient() {
  const cookieStore = cookies();

  return createServerClient(config.supabase.url, config.supabase.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot set cookies.
          // Middleware refreshes the session on subsequent requests.
        }
      },
    },
  });
}
