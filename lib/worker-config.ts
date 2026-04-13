/**
 * Worker config — standalone environment validation for the Railway worker process.
 *
 * This file intentionally imports NOTHING from Next.js or from lib/config.ts.
 * It reads process.env directly so it can be safely loaded before any Next.js
 * module is evaluated.
 *
 * The Railway worker calls validateWorkerConfig() at startup to fail fast with
 * a clear error message if any required variable is missing, rather than
 * crashing mid-job with a cryptic undefined error.
 */

// The environment variables the worker actually needs.
// SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) must be present so createAdminClient()
// gets a real URL — on Railway, NEXT_PUBLIC_* vars are not automatically available,
// so set plain SUPABASE_URL in the Railway service environment settings.
const REQUIRED: readonly string[] = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

/**
 * Validates the four environment variables required by the Railway worker.
 * Throws with a clear list of missing variables if any are absent.
 * Call this once at the very top of workers/agent-worker.ts before any other imports execute.
 */
export function validateWorkerConfig(): void {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `[worker] Missing required environment variables:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        `\n\nSet these variables in the Railway service environment settings.`
    );
  }

  // Supabase URL check — must have at least one of these so createAdminClient()
  // gets a real URL. On Railway set SUPABASE_URL (same value as your project URL).
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  if (!supabaseUrl) {
    throw new Error(
      `[worker] Missing Supabase URL. ` +
        `Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) in the Railway service environment settings. ` +
        `Value should be your Supabase project URL, e.g. https://xxxx.supabase.co`
    );
  }
}

/**
 * Typed worker configuration — reads only the variables the worker needs.
 * Populated after validateWorkerConfig() has confirmed all values are present.
 */
export const workerConfig = {
  supabase: {
    url:            process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model:  "claude-sonnet-4-20250514" as const,
  },
  openai: {
    // Optional — Claude-to-OpenAI fallback is disabled when absent.
    apiKey: process.env.OPENAI_API_KEY,
    model:  "gpt-4o" as const,
  },
  redis: {
    url:   process.env.UPSTASH_REDIS_REST_URL   ?? "",
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
  },
} as const;
