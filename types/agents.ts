// Agent types used across the queue, workers, and API routes.

// ------------------------------------------------------------------
// AgentName — all 14 agents defined in CLAUDE.md
// Union type used for type-safety; AGENT_NAMES array for runtime use
// (e.g. validation, BullMQ job name mapping).
// ------------------------------------------------------------------

export type AgentName =
  // Tier 1 — receive instructions from co-founders / orchestrate
  | "ceo"
  | "cfo"
  | "master"
  // Tier 2 — sub-agents dispatched only by the master agent
  | "sourcing"
  | "contact"
  | "scoring"
  | "loi"
  | "outreach"
  | "sec"
  | "narrative"
  | "structuring"
  | "optimization"
  | "pipe"
  | "redemption";

/** Runtime array — use for validation, iteration, and exhaustiveness checks. */
export const AGENT_NAMES: readonly AgentName[] = [
  "ceo",
  "cfo",
  "master",
  "sourcing",
  "contact",
  "scoring",
  "loi",
  "outreach",
  "sec",
  "narrative",
  "structuring",
  "optimization",
  "pipe",
  "redemption",
] as const;

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === "string" && (AGENT_NAMES as readonly string[]).includes(value);
}

// ------------------------------------------------------------------
// AgentInput — what every agent receives from the BullMQ job payload
// ------------------------------------------------------------------

export interface AgentInput {
  /** UUID of the agent_tasks row logged before dispatch */
  taskId: string;
  /** Which agent should process this job */
  agentName: AgentName;
  /** Target company, if this job is company-scoped */
  companyId?: string;
  /** Free-text prompt — used only by the CEO agent (from co-founders) */
  prompt?: string;
  /**
   * Must be explicitly true before any agent takes an external action
   * (sending email, filing SEC docs, contacting PIPE investors, etc.).
   * Defaults to false when absent.
   */
  approvedByHuman?: boolean;
  /** Agent-specific structured data */
  payload?: Record<string, unknown>;
}

// ------------------------------------------------------------------
// AgentOutput — what every agent returns and writes to agent_tasks.output
// ------------------------------------------------------------------

export interface AgentOutput {
  taskId: string;
  agentName: AgentName;
  success: boolean;
  /** Parsed JSON result from the LLM — shape varies per agent */
  data?: Record<string, unknown>;
  /** Error message if success is false */
  error?: string;
}

// ------------------------------------------------------------------
// AgentDispatchOptions — optional BullMQ overrides per job
// ------------------------------------------------------------------

export interface AgentDispatchOptions {
  /** Higher number = higher priority in the queue */
  priority?: number;
  /** Milliseconds to wait before the job becomes active */
  delay?: number;
  /** Override the default retry count (default: 3) */
  attempts?: number;
}
