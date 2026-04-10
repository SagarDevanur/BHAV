// Central config — all environment variables must be accessed from here.
// Never use process.env directly anywhere else in the codebase.
//
// SERVER-ONLY variables (SUPABASE_SERVICE_ROLE_KEY, CLERK_SECRET_KEY,
// ANTHROPIC_API_KEY, OPENAI_API_KEY, UPSTASH_*) must never be imported
// from client components. Only import this file in server-side code,
// API routes, and workers.

// ---------------------------------------------------------------------------
// Variable sets
// ---------------------------------------------------------------------------

// Always required — both Next.js (Vercel) and Railway worker must have these.
const WORKER_REQUIRED_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

// Required only in the Next.js context (Vercel).
// Railway workers do not expose NEXT_PUBLIC_ vars, so we skip this check
// when NODE_ENV=production and the first NEXT_PUBLIC_ var is absent —
// that combination reliably identifies the worker process.
const NEXTJS_REQUIRED_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
] as const;

// Optional variables — features degrade gracefully when absent:
// OPENAI_API_KEY       : Claude-to-OpenAI fallback disabled; Claude failures will throw.
// CLERK_WEBHOOK_SECRET : Clerk webhook endpoint will reject all requests until set.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isWorkerContext(): boolean {
  // Heuristic: production build without any NEXT_PUBLIC_ vars → Railway worker.
  return (
    process.env.NODE_ENV === "production" &&
    !process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}

function validateEnv(): void {
  const requiredVars: readonly string[] = isWorkerContext()
    ? WORKER_REQUIRED_VARS
    : [...WORKER_REQUIRED_VARS, ...NEXTJS_REQUIRED_VARS];

  const missing = requiredVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    const hint = isWorkerContext()
      ? "Set these variables in the Railway service environment."
      : "Copy .env.local.example to .env.local and fill in all values.";
    throw new Error(
      `Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join("\n")}\n\n${hint}`
    );
  }
}

// Validate eagerly at module load time so the error surfaces immediately
// on startup rather than at the point of first use.
validateEnv();

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

// Always-available (worker + Next.js).
function workerEnv(key: (typeof WORKER_REQUIRED_VARS)[number]): string {
  return process.env[key] as string;
}

// Next.js-only — returns empty string in worker context where the var is absent.
// Values are only consumed by Next.js at runtime (browser bundle, Clerk middleware),
// so an empty string in the worker is safe and never reached.
function nextEnv(key: (typeof NEXTJS_REQUIRED_VARS)[number]): string {
  return process.env[key] ?? "";
}

// ---------------------------------------------------------------------------
// Config object
// ---------------------------------------------------------------------------

export const config = {
  supabase: {
    // Safe for browser — public Supabase project URL
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    // Safe for browser — anon (row-level-security) key
    anonKey: nextEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    // SERVER ONLY — bypasses RLS; never expose to the browser
    serviceRoleKey: workerEnv("SUPABASE_SERVICE_ROLE_KEY"),
  },
  clerk: {
    // Safe for browser — Clerk publishable key
    publishableKey: nextEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    // SERVER ONLY — Clerk secret key
    secretKey: nextEnv("CLERK_SECRET_KEY"),
    // SERVER ONLY — used to verify Clerk webhook signatures (optional at startup)
    webhookSecret: process.env.CLERK_WEBHOOK_SECRET,
    signInUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in",
    afterSignInUrl: process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL ?? "/",
  },
  anthropic: {
    // SERVER ONLY
    apiKey: workerEnv("ANTHROPIC_API_KEY"),
    model: "claude-sonnet-4-20250514" as const,
  },
  openai: {
    // SERVER ONLY — fallback LLM when Anthropic API fails (optional at startup)
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o" as const,
  },
  redis: {
    // SERVER ONLY — Upstash Redis REST endpoint for BullMQ
    url: workerEnv("UPSTASH_REDIS_REST_URL"),
    token: workerEnv("UPSTASH_REDIS_REST_TOKEN"),
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
