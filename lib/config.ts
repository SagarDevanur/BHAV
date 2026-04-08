// Central config — all environment variables must be accessed from here.
// Never use process.env directly anywhere else in the codebase.
//
// SERVER-ONLY variables (SUPABASE_SERVICE_ROLE_KEY, CLERK_SECRET_KEY,
// ANTHROPIC_API_KEY, OPENAI_API_KEY, UPSTASH_*) must never be imported
// from client components. Only import this file in server-side code,
// API routes, and workers.

// Required variables — app will not start if any are missing.
const REQUIRED_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "ANTHROPIC_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

// Optional variables — features degrade gracefully when absent:
// OPENAI_API_KEY       : Claude-to-OpenAI fallback disabled; Claude failures will throw.
// CLERK_WEBHOOK_SECRET : Clerk webhook endpoint will reject all requests until set.

function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join("\n")}\n\nCopy .env.local.example to .env.local and fill in all values.`
    );
  }
}

// Validate eagerly at module load time so the error surfaces immediately
// on startup rather than at the point of first use.
validateEnv();

// After validation we know required vars are defined — cast is safe.
function env(key: (typeof REQUIRED_VARS)[number]): string {
  return process.env[key] as string;
}


export const config = {
  supabase: {
    // Safe for browser — public Supabase project URL
    url: env("NEXT_PUBLIC_SUPABASE_URL"),
    // Safe for browser — anon (row-level-security) key
    anonKey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    // SERVER ONLY — bypasses RLS; never expose to the browser
    serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  },
  clerk: {
    // Safe for browser — Clerk publishable key
    publishableKey: env("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    // SERVER ONLY — Clerk secret key
    secretKey: env("CLERK_SECRET_KEY"),
    // SERVER ONLY — used to verify Clerk webhook signatures (optional at startup)
    webhookSecret: process.env.CLERK_WEBHOOK_SECRET,
    signInUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in",
    afterSignInUrl: process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL ?? "/",
  },
  anthropic: {
    // SERVER ONLY
    apiKey: env("ANTHROPIC_API_KEY"),
    model: "claude-sonnet-4-20250514" as const,
  },
  openai: {
    // SERVER ONLY — fallback LLM when Anthropic API fails (optional at startup)
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o" as const,
  },
  redis: {
    // SERVER ONLY — Upstash Redis REST endpoint for BullMQ
    url: env("UPSTASH_REDIS_REST_URL"),
    token: env("UPSTASH_REDIS_REST_TOKEN"),
  },
  app: {
    url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  },
} as const;

export type Config = typeof config;
