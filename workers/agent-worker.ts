// BullMQ worker — runs on Railway, processes all agent jobs from the queue.
// This is the only place where agent functions are invoked.
import { Worker } from "bullmq";
import { AGENT_QUEUE_NAME } from "@/lib/queue/queue";
import { runCeoAgent } from "@/lib/agents/ceo-agent";
import { runCfoAgent } from "@/lib/agents/cfo-agent";
import { runMasterAgent } from "@/lib/agents/master-agent";
import { runSourcingAgent } from "@/lib/agents/sub-agents/sourcing-agent";
import { runContactAgent } from "@/lib/agents/sub-agents/contact-agent";
import { runScoringAgent } from "@/lib/agents/sub-agents/scoring-agent";
import { runLoiAgent } from "@/lib/agents/sub-agents/loi-agent";
import { runOutreachAgent } from "@/lib/agents/sub-agents/outreach-agent";
import { runSecAgent } from "@/lib/agents/sub-agents/sec-agent";
import { runNarrativeAgent } from "@/lib/agents/sub-agents/narrative-agent";
import { runStructuringAgent } from "@/lib/agents/sub-agents/structuring-agent";
import { runOptimizationAgent } from "@/lib/agents/sub-agents/optimization-agent";
import { runPipeAgent } from "@/lib/agents/sub-agents/pipe-agent";
import { runRedemptionAgent } from "@/lib/agents/sub-agents/redemption-agent";
import type { AgentInput } from "@/types/agents";

const connection = {
  host: process.env.UPSTASH_REDIS_REST_URL?.replace("https://", "") ?? "",
  port: 6379,
  password: process.env.UPSTASH_REDIS_REST_TOKEN,
  tls: {},
};

const worker = new Worker<AgentInput>(
  AGENT_QUEUE_NAME,
  async (job) => {
    const input = job.data;

    switch (input.agentName) {
      case "ceo":
        return runCeoAgent(input);
      case "cfo":
        return runCfoAgent(input);
      case "master":
        return runMasterAgent(input);
      case "sourcing":
        return runSourcingAgent(input);
      case "contact":
        return runContactAgent(input);
      case "scoring":
        return runScoringAgent(input);
      case "loi":
        return runLoiAgent(input);
      case "outreach":
        return runOutreachAgent(input);
      case "sec":
        return runSecAgent(input);
      case "narrative":
        return runNarrativeAgent(input);
      case "structuring":
        return runStructuringAgent(input);
      case "optimization":
        return runOptimizationAgent(input);
      case "pipe":
        return runPipeAgent(input);
      case "redemption":
        return runRedemptionAgent(input);
      default: {
        // TypeScript exhaustiveness check — this branch should be unreachable.
        // If a new AgentName is added to types/agents.ts but not handled here,
        // this cast will surface a compile error.
        const unhandled: never = input.agentName as never;
        throw new Error(`Unknown agent: ${String(unhandled)}`);
      }
    }
  },
  { connection }
);

worker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} (${job.data.agentName}) completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job ${job?.id} (${job?.data.agentName}) failed:`, err);
});

console.log("[worker] Agent worker started, listening on queue:", AGENT_QUEUE_NAME);
