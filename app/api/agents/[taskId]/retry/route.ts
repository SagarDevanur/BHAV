// POST /api/agents/[taskId]/retry
// Re-dispatches a failed agent_task using its original input payload.
// Only works on tasks with status = "failed".
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchAgentJob } from "@/lib/queue/dispatcher";
import { isAgentName } from "@/types/agents";

export async function POST(
  _request: Request,
  { params }: { params: { taskId: string } }
) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  try {
    // Fetch the original task
    const { data: task, error: fetchError } = await supabase
      .from("agent_tasks")
      .select("*")
      .eq("id", params.taskId)
      .single();

    if (fetchError || !task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    if (task.status !== "failed") {
      return NextResponse.json(
        { error: "Only failed tasks can be retried" },
        { status: 422 }
      );
    }

    if (!isAgentName(task.agent_name)) {
      return NextResponse.json({ error: "Unknown agent name" }, { status: 422 });
    }

    // Re-dispatch with the original validated payload. dispatchAgentJob will
    // re-validate the payload against the agent's Zod schema before enqueuing.
    const result = await dispatchAgentJob(
      task.agent_name,
      task.input as Record<string, unknown> & { _agent: typeof task.agent_name }
    );

    return NextResponse.json({ taskId: result.taskId }, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
