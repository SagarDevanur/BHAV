# BHAV Acquisition Corp — Claude Code Rules

> This file is read by Claude Code at the start of every session.
> Follow every rule in this file exactly. Do not deviate from the tech stack, folder structure, or conventions defined here.

---

## 1. Project Overview

BHAV Acquisition Corp is an internal deal platform for two co-founders.
The system uses an LLM-driven autonomous agent hierarchy to identify, score, and action M&A opportunities for deSPAC transactions.

Agents scrape the web, enrich contact data, score targets, and draft deal documents — all without manual intervention.
Co-founders interact only via an internal dashboard where they prompt agents and approve or reject targets.

**Users:** 2 co-founders only. No public access.
**Goal:** Find companies with $5–50M revenue that are suitable deSPAC targets, enrich their contact data, score them, and progress the best ones to LOI and PIPE outreach.

---

## 2. Tech Stack

> Do not deviate from this stack. Do not suggest alternatives.

| Layer | Technology |
|---|---|
| Framework | Next.js 14 with App Router |
| Language | TypeScript — strict mode, no `any` types ever |
| Styling | Tailwind CSS only — no inline styles, no CSS modules |
| Database | Supabase (PostgreSQL) |
| Auth | Clerk — two co-founder accounts only |
| Agent Queue | BullMQ with Redis (Upstash) |
| LLM Primary | Anthropic Claude API — `claude-sonnet-4-20250514` |
| LLM Fallback | OpenAI GPT-4o |
| Hosting | Vercel (frontend) + Railway (agent worker) |
| Package Manager | pnpm — never use npm or yarn |

---

## 3. Folder Structure

> Place every file in the correct location. Do not create folders outside this structure without asking first.

```
bhav/
├── app/
│   ├── (auth)/
│   │   ├── sign-in/
│   │   │   └── page.tsx
│   │   └── sign-up/
│   │       └── page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx
│   │   ├── page.tsx                  # Deal pipeline view
│   │   ├── companies/
│   │   │   ├── page.tsx              # Company list
│   │   │   └── [id]/
│   │   │       └── page.tsx          # Company detail
│   │   ├── agents/
│   │   │   └── page.tsx              # Agent monitor
│   │   └── settings/
│   │       └── page.tsx
│   ├── api/
│   │   ├── agents/
│   │   │   └── ceo/
│   │   │       └── route.ts
│   │   ├── companies/
│   │   │   └── route.ts
│   │   └── webhooks/
│   │       └── clerk/
│   │           └── route.ts
│   ├── layout.tsx
│   └── globals.css
├── components/
│   ├── ui/
│   ├── dashboard/
│   └── agents/
├── lib/
│   ├── supabase/
│   │   ├── client.ts
│   │   ├── server.ts
│   │   └── admin.ts
│   ├── agents/
│   │   ├── prompts.ts
│   │   ├── ceo-agent.ts
│   │   ├── cfo-agent.ts
│   │   ├── master-agent.ts
│   │   └── sub-agents/
│   │       ├── sourcing-agent.ts
│   │       ├── contact-agent.ts
│   │       ├── scoring-agent.ts
│   │       ├── loi-agent.ts
│   │       ├── outreach-agent.ts
│   │       ├── sec-agent.ts
│   │       ├── narrative-agent.ts
│   │       ├── structuring-agent.ts
│   │       ├── optimization-agent.ts
│   │       ├── pipe-agent.ts
│   │       └── redemption-agent.ts
│   ├── queue/
│   │   ├── queue.ts
│   │   ├── jobs.ts
│   │   └── dispatcher.ts
│   ├── config.ts
│   └── utils/
├── types/
│   ├── database.ts
│   └── agents.ts
├── workers/
│   └── agent-worker.ts
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql
├── scripts/
│   └── seed-companies.ts
├── middleware.ts
├── .env.local
├── .env.local.example
├── vercel.json
└── CLAUDE.md
```

---

## 4. Database Schema

> Use these exact table names and column names everywhere. Never rename them.

### `companies`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `name` | text | not null |
| `website` | text | |
| `sector` | text | Physical AI, Drones & UAV, FinTech, Autonomous EVs |
| `sub_sector` | text | |
| `blurb` | text | |
| `last_round` | text | |
| `estimated_valuation` | text | |
| `despac_score` | integer | 0–100, set by scoring agent |
| `status` | text | sourced, scoring, reviewed, approved, rejected, loi_sent |
| `created_at` | timestamptz | default now() |
| `updated_at` | timestamptz | default now() |

### `contacts`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `company_id` | uuid | references companies(id) |
| `name` | text | |
| `title` | text | |
| `email` | text | |
| `linkedin_url` | text | |
| `phone` | text | |
| `enriched_at` | timestamptz | |
| `created_at` | timestamptz | default now() |

### `agent_tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `agent_name` | text | see AgentName enum in types/agents.ts |
| `status` | text | queued, running, completed, failed |
| `input` | jsonb | |
| `output` | jsonb | |
| `error` | text | |
| `started_at` | timestamptz | |
| `completed_at` | timestamptz | |
| `created_at` | timestamptz | default now() |

### `agent_results`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `task_id` | uuid | references agent_tasks(id) |
| `company_id` | uuid | references companies(id) |
| `agent_name` | text | |
| `result_type` | text | score, contact, loi_draft, outreach_email, sec_draft, narrative |
| `content` | jsonb | |
| `created_at` | timestamptz | default now() |

### `deal_pipeline`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `company_id` | uuid | references companies(id) unique |
| `stage` | text | sourced, scored, loi, diligence, pipe, announced |
| `despac_score` | integer | |
| `approved_by` | text | co-founder name |
| `notes` | text | |
| `updated_at` | timestamptz | default now() |

---

## 5. Agent Rules

> These rules protect the integrity of the system and enforce human oversight.

- Every agent must have a system prompt defined in `lib/agents/prompts.ts`
- Every agent job must be dispatched via BullMQ — **never call an agent directly from a UI component**
- Every agent must log its task to `agent_tasks` before starting and update on completion or failure
- **Agents must never send emails or take any external action unless `approvedByHuman: true` is in the task input**
- The CEO agent is the **only** agent that receives prompts directly from co-founders
- The Master agent is the **only** agent that dispatches sub-agents
- Claude model to use in all agents: `claude-sonnet-4-20250514`
- If Claude API fails, fall back to OpenAI `gpt-4o` — never fail silently

---

## 6. Code Style Rules

- All components must be **functional components with named exports**
- Only `page.tsx` and `layout.tsx` use default exports
- Use `async/await` — never `.then()` chains
- All Supabase queries must be wrapped in `try/catch` with typed errors
- All API routes must validate input with **Zod** before processing
- Access all environment variables via `lib/config.ts` — **never use `process.env` directly**
- Never hardcode API keys, URLs, or secrets anywhere in the codebase

---

## 7. Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Component files | kebab-case | `deal-card.tsx` |
| Utility files | camelCase | `formatScore.ts` |
| Components | PascalCase | `DealCard` |
| Functions & variables | camelCase | `dispatchAgentJob` |
| Database columns | snake_case | `despac_score` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRIES` |
| Agent names in code | lowercase string | `"ceo"`, `"scoring"` |

---

## 8. Environment Variables

> Access only through `lib/config.ts`. Never commit `.env.local`.

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/

# Anthropic
ANTHROPIC_API_KEY=

# OpenAI (fallback)
OPENAI_API_KEY=

# Redis / Upstash (BullMQ)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## 9. What to Always Do

- Run `pnpm typecheck` after every major change
- Create a migration file in `supabase/migrations/` for every DB schema change
- Check `agent_tasks` table status before re-running an agent to avoid duplicates
- Keep all agent system prompts in `lib/agents/prompts.ts` — never inline them in workers
- Add a comment above every agent function explaining inputs and outputs

---

## 10. What to Never Do

- ❌ Never use `any` in TypeScript
- ❌ Never call Claude or OpenAI API directly from a page or component
- ❌ Never skip the human approval gate before outreach, LOI, or SEC filing actions
- ❌ Never expose `SUPABASE_SERVICE_ROLE_KEY` or `ANTHROPIC_API_KEY` to the browser
- ❌ Never create new database tables without a migration file
- ❌ Never use `npm` or `yarn` — pnpm only
- ❌ Never put business logic inside a Next.js page file
- ❌ Never import `lib/supabase/admin.ts` from any client-side file
