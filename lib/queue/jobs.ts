// Typed job definitions for every agent.
// Each agent has:
//   - JOB_NAMES entry     — the BullMQ job name string
//   - inputSchema         — Zod schema that validates the payload before enqueue
//   - outputSchema        — Zod schema that validates the LLM response before DB write
//
// NOTE: Uses Zod v4 API — z.record() requires (keySchema, valueSchema),
// and integer types use z.int() not z.number().int().
import { z } from "zod";
import type { AgentName } from "@/types/agents";

// ---------------------------------------------------------------------------
// BullMQ job name map (one entry per AgentName)
// ---------------------------------------------------------------------------

export const JOB_NAMES: Record<AgentName, string> = {
  ceo:          "ceo-task",
  cfo:          "cfo-task",
  master:       "master-task",
  sourcing:     "sourcing-task",
  contact:      "contact-enrichment",
  scoring:      "scoring-task",
  loi:          "loi-draft",
  outreach:     "outreach-task",
  sec:          "sec-filing",
  narrative:    "narrative-task",
  structuring:  "structuring-task",
  optimization: "optimization-task",
  pipe:         "pipe-task",
  redemption:   "redemption-task",
} as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RETRIES = 3;
export const JOB_TIMEOUT_MS = 120_000; // 2 min per job

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
const str  = z.string().min(1);
// Zod v4: z.record() requires keySchema + valueSchema
const jsonObject = z.record(z.string(), z.unknown());
// Zod v4: integer types use z.int() (not z.number().int())
const score100 = z.number().min(0).max(100);
const score20  = z.number().min(0).max(20);

// ---------------------------------------------------------------------------
// Per-agent INPUT schemas — validated by dispatcher before enqueue
// ---------------------------------------------------------------------------

export const jobInputSchemas: Record<AgentName, z.ZodTypeAny> = {
  ceo: z.object({
    prompt:    str.max(4_000),
    founderId: str,
  }),

  cfo: z.object({
    companyId:     uuid,
    financialData: jsonObject.optional(),
  }),

  master: z.object({
    ceoOutput: z.object({
      action:      str,
      targetAgent: str,
      parameters:  jsonObject,
      reasoning:   str,
    }),
    companyId: uuid.optional(),
  }),

  sourcing: z.object({
    sector: z
      .enum(["Physical AI", "Drones & UAV", "FinTech", "Autonomous EVs"])
      .optional(),
    searchCriteria: jsonObject.optional(),
  }),

  contact: z.object({
    companyId:   uuid,
    companyName: str,
    website:     z.string().nullable(),
  }),

  scoring: z.object({
    companyId: uuid,
    company:   jsonObject,
  }),

  loi: z.object({
    companyId:       uuid,
    approvedByHuman: z.literal(true),
    company:         jsonObject,
    terms:           jsonObject.optional(),
  }),

  outreach: z.object({
    companyId:       uuid,
    approvedByHuman: z.boolean().optional(),
    contact:         jsonObject,
    company:         jsonObject,
  }),

  sec: z.object({
    companyId:       uuid,
    approvedByHuman: z.literal(true),
    documentType:    z.enum(["S-4", "proxy", "8-K", "other"]),
    dealData:        jsonObject,
  }),

  narrative: z.object({
    companyId:      uuid,
    company:        jsonObject,
    scoreBreakdown: jsonObject.optional(),
  }),

  structuring: z.object({
    companyId:       uuid,
    company:         jsonObject,
    valuationTarget: z.string().optional(),
  }),

  optimization: z.object({
    companyId:    uuid,
    currentTerms: jsonObject,
  }),

  pipe: z.object({
    companyId:       uuid,
    approvedByHuman: z.boolean().optional(),
    dealTerms:       jsonObject,
  }),

  redemption: z.object({
    companyId:        uuid,
    dealData:         jsonObject,
    marketConditions: jsonObject.optional(),
  }),
};

// ---------------------------------------------------------------------------
// Per-agent OUTPUT schemas — validated after LLM responds, before DB write
// ---------------------------------------------------------------------------

export const jobOutputSchemas: Record<AgentName, z.ZodTypeAny> = {
  ceo: z.object({
    action:      str,
    targetAgent: str,
    parameters:  jsonObject,
    reasoning:   str,
  }),

  cfo: z.object({
    financialAssessment: str,
    revenueEstimate:     z.string(),
    fitScore:            score100,
    flags:               z.array(z.string()),
  }),

  master: z.object({
    sub_agents: z.array(z.string()),
    reasoning:  str,
  }),

  sourcing: z.object({
    companies: z.array(
      z.object({
        name:                str,
        website:             z.string().nullable(),
        sector:              z.string(),
        sub_sector:          z.string().nullable(),
        blurb:               z.string().nullable(),
        estimated_valuation: z.string().nullable(),
        last_round:          z.string().nullable(),
      })
    ),
  }),

  contact: z.object({
    contacts: z.array(
      z.object({
        name:         z.string().nullable(),
        title:        z.string().nullable(),
        email:        z.string().nullable(),
        linkedin_url: z.string().nullable(),
        phone:        z.string().nullable(),
      })
    ),
  }),

  scoring: z.object({
    despac_score: score100,
    breakdown: z.object({
      revenue:    score20,
      sector:     score20,
      management: score20,
      timing:     score20,
      structure:  score20,
    }),
    recommendation: str,
  }),

  loi: z.object({
    loi_draft:  str,
    key_terms:  jsonObject,
    next_steps: z.array(z.string()),
  }),

  outreach: z.object({
    subject:        str,
    body:           str,
    recipient:      z.string(),
    tone:           z.string(),
    call_to_action: z.string(),
  }),

  sec: z.object({
    document_type:        str,
    draft_content:        str,
    required_disclosures: z.array(z.string()),
    compliance_notes:     z.string(),
  }),

  narrative: z.object({
    headline:              str,
    investment_thesis:     str,
    market_opportunity:    str,
    management_highlights: str,
    risks:                 z.array(z.string()),
  }),

  structuring: z.object({
    structure_type:     str,
    valuation_approach: str,
    earnout_terms:      z.string().nullable(),
    pipe_requirements:  z.string(),
    timeline:           z.string(),
  }),

  optimization: z.object({
    current_terms:   jsonObject,
    optimized_terms: jsonObject,
    rationale:       str,
    risk_reduction:  str,
  }),

  pipe: z.object({
    target_investors:  z.array(jsonObject),
    investment_thesis: str,
    terms_summary:     str,
    outreach_drafts:   z.array(jsonObject),
  }),

  redemption: z.object({
    redemption_risk_score: score100,
    risk_factors:          z.array(z.string()),
    mitigation_strategies: z.array(z.string()),
    recommended_actions:   z.array(z.string()),
  }),
};

// ---------------------------------------------------------------------------
// Convenience derived types
// ---------------------------------------------------------------------------

export type JobInput<T extends AgentName>  = z.infer<z.ZodTypeAny> & { _agent: T };
export type JobOutput<T extends AgentName> = z.infer<z.ZodTypeAny> & { _agent: T };
