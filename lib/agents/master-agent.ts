// Master Agent — the only agent that dispatches sub-agents via BullMQ.
// Input: { taskId, payload: { ceoOutput, companyId? } }
// Output: { dispatched_jobs: string[]; reasoning: string }
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { prompts } from "./prompts";
import { dispatchAgentJob } from "@/lib/queue/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAgentName } from "@/types/agents";
import type { AgentInput } from "@/types/agents";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Runs the Master agent, which breaks down CEO output into sub-agent jobs.
 * Each sub-agent is dispatched via dispatchAgentJob (which handles DB logging).
 * @param input - AgentInput from the BullMQ worker
 * @returns Summary of dispatched task IDs and reasoning
 */
export async function runMasterAgent(
  input: AgentInput
): Promise<Record<string, unknown>> {
  const supabase = createAdminClient();

  await supabase
    .from("agent_tasks")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", input.taskId);

  try {
    const userMessage = JSON.stringify(input.payload ?? {});
    let responseText: string;

    try {
      const message = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 2048,
        system: prompts.master,
        messages: [{ role: "user", content: userMessage }],
      });
      responseText =
        message.content[0].type === "text" ? message.content[0].text : "";
    } catch {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: "system", content: prompts.master },
          { role: "user", content: userMessage },
        ],
      });
      responseText = completion.choices[0]?.message?.content ?? "";
    }

    const plan = JSON.parse(responseText) as {
      sub_agents: string[];
      reasoning: string;
    };

    // Dispatch each sub-agent via the dispatcher (which logs to agent_tasks)
    const dispatchedTaskIds: string[] = [];

    for (const rawName of plan.sub_agents ?? []) {
      if (!isAgentName(rawName)) {
        console.warn(`[master] Unknown agent name from LLM: "${rawName}" — skipping`);
        continue;
      }

      try {
        // Build a minimal payload for each sub-agent using companyId if available
        const subPayload =
          rawName === "scoring" || rawName === "contact" || rawName === "narrative"
            ? { companyId: input.companyId ?? "", company: input.payload?.company ?? {} }
            : { companyId: input.companyId, ...input.payload };

        const { taskId } = await dispatchAgentJob(
          rawName,
          // Each sub-agent schema validates its own payload; pass through
          // companyId + whatever the master received. Workers handle missing fields.
          subPayload as unknown as Parameters<typeof dispatchAgentJob>[1],
          { attempts: 3 }
        );
        dispatchedTaskIds.push(taskId);
      } catch (err) {
        console.error(`[master] Failed to dispatch "${rawName}":`, err);
      }
    }

    const result = {
      dispatched_jobs: dispatchedTaskIds,
      reasoning: plan.reasoning,
    };

    await supabase
      .from("agent_tasks")
      .update({
        status: "completed",
        output: result,
        completed_at: new Date().toISOString(),
      })
      .eq("id", input.taskId);

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await supabase
      .from("agent_tasks")
      .update({ status: "failed", error, completed_at: new Date().toISOString() })
      .eq("id", input.taskId);
    throw err;
  }
}
