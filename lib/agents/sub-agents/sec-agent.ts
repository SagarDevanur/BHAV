// SEC Filing Agent — drafts SEC documents (S-4, proxy) for deSPAC transactions.
// Requires approvedByHuman: true before producing any filing-ready documents.
// Input: { companyId: string; approvedByHuman: true; payload: { document_type: string; deal_data: unknown } }
// Output: { document_type, draft_content, required_disclosures, compliance_notes }
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { prompts } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Runs the SEC agent to draft regulatory filing documents.
 * Will throw if approvedByHuman is not true.
 * @param input - AgentInput with document type and deal data payload
 * @returns SEC document draft and compliance notes
 */
export async function runSecAgent(
  input: AgentInput
): Promise<Record<string, unknown>> {
  if (!input.approvedByHuman) {
    throw new Error("SEC agent requires human approval before drafting filings.");
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
        max_tokens: 8192,
        system: prompts.sec,
        messages: [{ role: "user", content: userMessage }],
      });
      responseText =
        message.content[0].type === "text" ? message.content[0].text : "";
    } catch {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: "system", content: prompts.sec },
          { role: "user", content: userMessage },
        ],
      });
      responseText = completion.choices[0]?.message?.content ?? "";
    }

    const result = JSON.parse(responseText) as Record<string, unknown>;

    await supabase.from("agent_results").insert({
      task_id: input.taskId,
      company_id: input.companyId ?? null,
      agent_name: "sec",
      result_type: "sec_draft",
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
