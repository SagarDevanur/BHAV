// BullMQ queue connected to Upstash Redis over TLS.
// This module is server-only by design — never import from client components.
// The 'server-only' package is intentionally omitted: this file is also imported
// by the Railway worker (plain Node.js) which has no Next.js runtime available.
import { Queue } from "bullmq";
import { config } from "@/lib/config";
import type { AgentInput } from "@/types/agents";

// Upstash provides a REST URL of the form:
//   https://<host>.upstash.io
// BullMQ uses ioredis which needs a TCP connection:
//   host: <host>.upstash.io  port: 6379  password: <token>  tls: {}
//
// We derive the TCP host by stripping the protocol from the REST URL.
function upstashHost(): string {
  return config.redis.url
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

export const redisConnection = {
  host: upstashHost(),
  port: 6379,
  password: config.redis.token,
  tls: {}, // Upstash requires TLS on port 6379
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,    // required for Upstash
} as const;

export const AGENT_QUEUE_NAME = "bhav-agent-jobs" as const;

export const agentQueue = new Queue<AgentInput>(AGENT_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2_000, // start at 2 s, then 4 s, 8 s
    },
    removeOnComplete: { count: 200 }, // keep last 200 completed jobs for the monitor
    removeOnFail: { count: 500 },     // keep last 500 failed jobs for debugging
  },
});

// Gracefully close the queue connection when the process exits.
// This prevents hanging connections during deploys and tests.
process.on("beforeExit", () => {
  agentQueue.close().catch(() => undefined);
});
