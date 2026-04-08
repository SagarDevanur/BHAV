# BHAV Acquisition Corp — Internal Deal Platform

An LLM-driven M&A pipeline for deSPAC transactions. Agents scrape, score, and action acquisition targets autonomously. Co-founders interact via an internal dashboard.

**Stack:** Next.js 14 · TypeScript · Tailwind CSS · Supabase · Clerk · BullMQ (Upstash Redis) · Anthropic Claude · Railway (agent worker) · Vercel (frontend)

---

## Local Development

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- A Supabase project
- A Clerk application
- An Anthropic API key
- An Upstash Redis database

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_ORG/bhav.git
cd bhav

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.local.example .env.local
# Fill in every value in .env.local (see Environment Variables below)

# 4. Apply the database schema
pnpm supabase db push
# — or run the SQL manually: supabase/migrations/001_initial_schema.sql

# 5. (Optional) Seed companies from the Excel file
pnpm seed

# 6. Start the development server
pnpm dev

# 7. In a separate terminal, start the agent worker
pnpm worker
```

Open [http://localhost:3000](http://localhost:3000). Sign in with your Clerk account.

---

## Deployment

### 1. Push to GitHub

```bash
# Initialise git if you haven't already
git init
git add .
git commit -m "feat: initial BHAV platform"

# Create a new private repository on github.com, then:
git remote add origin https://github.com/YOUR_ORG/bhav.git
git branch -M main
git push -u origin main
```

> `.env.local` is listed in `.gitignore` and will never be committed.
> Double-check with `git status` — it must not appear in the staged files.

---

### 2. Connect to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and sign in.
2. Click **Add New Project** → **Import Git Repository**.
3. Select the `bhav` repository from your GitHub organisation.
4. Vercel auto-detects Next.js. Leave **Framework Preset** as `Next.js`.
5. Set **Root Directory** to `.` (the repo root).
6. Do **not** click Deploy yet — add environment variables first (step 3).

---

### 3. Add Environment Variables in Vercel

In the Vercel project settings, go to **Settings → Environment Variables** and add each variable below. Set the environment to **Production**, **Preview**, and **Development** unless noted.

| Variable | Where to find it | Browser-safe? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` `public` key | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` key | **No — server only** |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk → API Keys → Publishable key | Yes |
| `CLERK_SECRET_KEY` | Clerk → API Keys → Secret key | **No — server only** |
| `CLERK_WEBHOOK_SECRET` | Clerk → Webhooks → your endpoint → Signing Secret | **No — server only** |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Set to `/sign-in` | Yes |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` | Set to `/` | Yes |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | **No — server only** |
| `OPENAI_API_KEY` | platform.openai.com → API Keys | **No — server only** |
| `UPSTASH_REDIS_REST_URL` | Upstash → your Redis DB → REST API → Endpoint | **No — server only** |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash → your Redis DB → REST API → Token | **No — server only** |
| `NEXT_PUBLIC_APP_URL` | Your Vercel production URL, e.g. `https://bhav.vercel.app` | Yes |

After adding all variables, click **Deploy**. Vercel will build and deploy the app.

---

### 4. Configure Clerk for Production

1. In the Clerk dashboard, go to **Domains** and add your Vercel production URL.
2. Go to **Webhooks → Add Endpoint**.
   - URL: `https://YOUR_VERCEL_URL/api/webhooks/clerk`
   - Events: `user.created`, `user.deleted`
3. Copy the **Signing Secret** into the `CLERK_WEBHOOK_SECRET` environment variable in Vercel, then redeploy.

---

### 5. Run the First Database Migration on Production

The migration file at `supabase/migrations/001_initial_schema.sql` creates all tables, indexes, triggers, and RLS policies.

**Option A — Supabase CLI (recommended)**

```bash
# Install Supabase CLI if you haven't
npm install -g supabase

# Link to your production project (find project-ref in Supabase dashboard URL)
supabase link --project-ref YOUR_PROJECT_REF

# Push the migration to production
supabase db push
```

**Option B — Supabase SQL Editor**

1. Open [supabase.com](https://supabase.com) → your project → **SQL Editor**.
2. Click **New query**.
3. Paste the entire contents of `supabase/migrations/001_initial_schema.sql`.
4. Click **Run**.

Verify the tables exist: go to **Table Editor** and confirm `companies`, `contacts`, `agent_tasks`, `agent_results`, and `deal_pipeline` are all present.

---

### 6. Seed Companies (Optional)

To import the target company list from `BHAV_Target_Companies.xlsx`:

```bash
# Make sure .env.local is populated with the production Supabase keys,
# or export them temporarily:
export NEXT_PUBLIC_SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...

pnpm seed
```

The seed script is safe to re-run — it skips records that already exist (matched by name + sector). Pass `--fresh` to wipe sourced records and re-seed from scratch.

---

### 7. Deploy the Agent Worker on Railway

The BullMQ worker (`workers/agent-worker.ts`) runs as a long-lived process and must be hosted separately from Vercel (which doesn't support persistent processes).

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
2. Select the `bhav` repository.
3. In **Settings → Start Command**, set:
   ```
   pnpm worker
   ```
4. Add every environment variable from step 3 to the Railway service (Railway → your service → **Variables**).
5. Deploy. The worker will connect to the same Upstash Redis queue that Vercel writes jobs to.

---

## Environment Variables Reference

See `.env.local.example` for the full annotated list. Every variable must be accessed through `lib/config.ts` — never use `process.env` directly in application code.

---

## Project Structure

```
app/                   Next.js App Router pages and API routes
components/dashboard/  All dashboard UI components
lib/agents/            Agent implementations and system prompts
lib/queue/             BullMQ dispatcher and job definitions
lib/supabase/          Supabase client helpers (client / server / admin)
types/                 Shared TypeScript types (database, agents)
workers/               Long-lived BullMQ worker process (runs on Railway)
supabase/migrations/   SQL migration files — one file per schema change
scripts/               One-off scripts (seed-companies)
```

---

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Next.js development server |
| `pnpm build` | Production build |
| `pnpm start` | Start production server |
| `pnpm worker` | Start BullMQ agent worker |
| `pnpm seed` | Import companies from Excel into Supabase |
| `pnpm typecheck` | Run TypeScript type-checker |
| `pnpm lint` | Run ESLint |
