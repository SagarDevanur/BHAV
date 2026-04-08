// Outreach Agent — drafts and (when approved) sends outreach emails to targets.
// Requires approvedByHuman: true before any external action.
// Input: { companyId: string; approvedByHuman?: boolean; payload: { contact: unknown; company: unknown } }
// Output: { subject, body, recipient, tone, call_to_action }
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { prompts } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Runs the Outreach agent to draft personalized outreach emails.
 * External sending is gated on approvedByHuman.
 * @param input - AgentInput with contact/company payload and optional approval flag
 * @returns Email draft
 */
export async function runOutreachAgent(
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
        system: prompts.outreach,
        messages: [{ role: "user", content: userMessage }],
      });
      responseText =
        message.content[0].type === "text" ? message.content[0].text : "";
    } catch {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: "system", content: prompts.outreach },
          { role: "user", content: userMessage },
        ],
      });
      responseText = completion.choices[0]?.message?.content ?? "";
    }

    const result = JSON.parse(responseText) as Record<string, unknown>;

    if (!input.approvedByHuman) {
      // Draft only — do not send
      result.status = "draft_pending_approval";
    }

    await supabase.from("agent_results").insert({
      task_id: input.taskId,
      company_id: input.companyId ?? null,
      agent_name: "outreach",
      result_type: "outreach_email",
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
