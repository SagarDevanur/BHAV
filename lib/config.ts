// Central config — all environment variables must be accessed from here.
// Never use process.env directly anywhere else in the codebase.
//
// SERVER-ONLY variables (SUPABASE_SERVICE_ROLE_KEY, CLERK_SECRET_KEY,
// ANTHROPIC_API_KEY, OPENAI_API_KEY, UPSTASH_*) must never be imported
// from client components. Only import this file in server-side code,
// API routes, and workers.
//
// VALIDATION:
//   validateWebConfig() — checks ALL required variables. Call this once at
//     Next.js startup (e.g. middleware.ts). It is NOT called automatically
//     so that the Railway worker can import agent modules (which transitively
//     import this file) without crashing on missing NEXT_PUBLIC_* variables.
//
//   The Railway worker validates its own subset via lib/worker-config.ts.

// ---------------------------------------------------------------------------
// Variable sets
// ---------------------------------------------------------------------------

// Required in both Next.js (Vercel) and the Railway worker.
const WORKER_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

// Required in Next.js only. Not present in the Railway worker environment.
const NEXTJS_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
] as const;

// Optional — features degrade gracefully when absent:
//   OPENAI_API_KEY       : Claude-to-OpenAI fallback disabled.
//   CLERK_WEBHOOK_SECRET : Clerk webhook endpoint will reject all requests.

// ---------------------------------------------------------------------------
// Validation — called explicitly, never at module load time
// ---------------------------------------------------------------------------

/**
 * Validates ALL required environment variables.
 * Call once at Next.js startup (e.g. top of middleware.ts).
 * Do NOT call from the Railway worker — use validateWorkerConfig() in lib/worker-config.ts.
 */
export function validateWebConfig(): void {
  const required = [...WORKER_VARS, ...NEXTJS_VARS] as readonly string[];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        `\n\nCopy .env.local.example to .env.local and fill in all values.`
    );
  }
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

// Returns the value for a var that is always required.
// Safe to cast to string — validateWebConfig() or validateWorkerConfig() must
// have been called first by the entry-point.
function required(key: (typeof WORKER_VARS)[number]): string {
  return process.env[key] as string;
}

// Returns the value for a Next.js-only var, or an empty string when running
// in the Railway worker (where these vars are not set).
// The empty string is safe: the worker never reaches code paths that consume
// these values (Supabase anon client, Clerk middleware, browser bundle).
function nextjsOnly(key: (typeof NEXTJS_VARS)[number]): string {
  return process.env[key] ?? "";
}

// ---------------------------------------------------------------------------
// Config object
// ---------------------------------------------------------------------------

export const config = {
  supabase: {
    // Safe for browser — public Supabase project URL
    url:            nextjsOnly("NEXT_PUBLIC_SUPABASE_URL"),
    // Safe for browser — anon (row-level-security) key
    anonKey:        nextjsOnly("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    // SERVER ONLY — bypasses RLS; never expose to the browser
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  },
  clerk: {
    // Safe for browser — Clerk publishable key
    publishableKey: nextjsOnly("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    // SERVER ONLY — Clerk secret key
    secretKey:      nextjsOnly("CLERK_SECRET_KEY"),
    // SERVER ONLY — used to verify Clerk webhook signatures (optional at startup)
    webhookSecret:  process.env.CLERK_WEBHOOK_SECRET,
    signInUrl:      process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL  ?? "/sign-in",
    afterSignInUrl: process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL ?? "/",
  },
  anthropic: {
    // SERVER ONLY
    apiKey: required("ANTHROPIC_API_KEY"),
    model:  "claude-sonnet-4-20250514" as const,
  },
  openai: {
    // SERVER ONLY — fallback LLM when Anthropic API fails (optional at startup)
    apiKey: process.env.OPENAI_API_KEY,
    model:  "gpt-4o" as const,
  },
  redis: {
    // SERVER ONLY — Upstash Redis REST endpoint for BullMQ
    url:   required("UPSTASH_REDIS_REST_URL"),
    token: required("UPSTASH_REDIS_REST_TOKEN"),
  },
  app: {
    url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  },
  googleNews: {
    // SERVER ONLY — optional. When absent the sourcing agent skips the news step.
    apiKey: process.env.GOOGLE_NEWS_API_KEY,
  },
  hunter: {
    // SERVER ONLY — optional. When absent the contact agent skips the Hunter.io step.
    apiKey: process.env.HUNTER_API_KEY,
  },
} as const;

export type Config = typeof config;
