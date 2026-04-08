// LOI Draft Agent — drafts Letters of Intent for approved deSPAC targets.
// Requires approvedByHuman: true in input before producing any documents.
// Input: { companyId: string; approvedByHuman: true; payload: { company: unknown; terms: unknown } }
// Output: { loi_draft, key_terms, next_steps }
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { prompts } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Runs the LOI agent to draft a Letter of Intent.
 * Will throw if approvedByHuman is not true.
 * @param input - AgentInput with companyId, human approval flag, and deal terms
 * @returns LOI draft and key terms
 */
export async function runLoiAgent(
  input: AgentInput
): Promise<Record<string, unknown>> {
  if (!input.approvedByHuman) {
    throw new Error("LOI agent requires human approval before drafting.");
  }

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
        max_tokens: 4096,
        system: prompts.loi,
        messages: [{ role: "user", content: userMessage }],
      });
      responseText =
        message.content[0].type === "text" ? message.content[0].text : "";
    } catch {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: "system", content: prompts.loi },
          { role: "user", content: userMessage },
        ],
      });
      responseText = completion.choices[0]?.message?.content ?? "";
    }

    const result = JSON.parse(responseText) as Record<string, unknown>;

    await supabase.from("agent_results").insert({
      task_id: input.taskId,
      company_id: input.companyId ?? null,
      agent_name: "loi",
      result_type: "loi_draft",
      content: result,
    });

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
