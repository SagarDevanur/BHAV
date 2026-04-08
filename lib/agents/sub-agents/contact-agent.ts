// Contact Enrichment Agent — enriches C-suite contact data for a target company.
// Input: { companyId: string; payload: { name: string; website: string } }
// Output: { contacts: [{ name, title, email, linkedin_url, phone }] }
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "@/lib/config";
import { prompts } from "@/lib/agents/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentInput } from "@/types/agents";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Runs the Contact agent to enrich executive contact data for a company.
 * @param input - AgentInput with companyId and company name/website payload
 * @returns Enriched contact records
 */
export async function runContactAgent(
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
        system: prompts.contact,
        messages: [{ role: "user", content: userMessage }],
      });
      responseText =
        message.content[0].type === "text" ? message.content[0].text : "";
    } catch {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: "system", content: prompts.contact },
          { role: "user", content: userMessage },
        ],
      });
      responseText = completion.choices[0]?.message?.content ?? "";
    }

    const result = JSON.parse(responseText) as Record<string, unknown>;

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
