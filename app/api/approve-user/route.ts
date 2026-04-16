import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isExceptionEmail } from "@/lib/auth-config";

const bodySchema = z.object({
  userId: z.string().min(1),
});

/**
 * POST /api/approve-user
 *
 * Sets publicMetadata.approved = true and pendingApproval = false for the
 * given userId. Only callable by exception-list emails (co-founders / admin).
 */
export async function POST(req: Request) {
  const { userId: callerId } = await auth();
  if (!callerId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }

  const { userId } = parsed.data;

  const client = await clerkClient();

  // Verify caller is an admin (exception email)
  const caller = await client.users.getUser(callerId);
  const callerEmail =
    caller.emailAddresses.find((e) => e.id === caller.primaryEmailAddressId)
      ?.emailAddress ?? "";

  if (!isExceptionEmail(callerEmail)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Approve the target user
  const target = await client.users.getUser(userId);
  const currentMeta = target.publicMetadata as Record<string, unknown>;

  await client.users.updateUserMetadata(userId, {
    publicMetadata: {
      ...currentMeta,
      approved: true,
      pendingApproval: false,
    },
  });

  return NextResponse.json({ status: "approved" });
}
