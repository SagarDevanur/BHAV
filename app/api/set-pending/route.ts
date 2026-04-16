import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ALLOWED_DOMAIN, isExceptionEmail } from "@/lib/auth-config";
import { sendApprovalRequestEmail } from "@/lib/email";

const bodySchema = z.object({
  userId: z.string().min(1),
});

/**
 * POST /api/set-pending
 *
 * Called from the sign-up page immediately after email verification for
 * @bhavspac.com (non-exception) users. Marks the user as pending approval
 * in Clerk publicMetadata so the dashboard layout blocks them until an
 * admin approves.
 *
 * No session auth required — the user has just verified their email but
 * has no active session yet. We validate that the userId belongs to a
 * real @bhavspac.com user before writing metadata.
 */
export async function POST(req: Request) {
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

  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);

    // Only mark @bhavspac.com non-exception users as pending
    const email =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? "";
    const emailLower = email.toLowerCase().trim();

    if (isExceptionEmail(emailLower)) {
      // Exception emails are always approved — nothing to do
      return NextResponse.json({ status: "already_approved" });
    }

    if (!emailLower.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return NextResponse.json(
        { error: "Email domain not permitted" },
        { status: 403 }
      );
    }

    // Set pending metadata (only if not already approved)
    const currentMeta = user.publicMetadata as Record<string, unknown>;
    if (currentMeta.approved === true) {
      return NextResponse.json({ status: "already_approved" });
    }

    await client.users.updateUserMetadata(userId, {
      publicMetadata: {
        ...currentMeta,
        pendingApproval: true,
        approved: false,
      },
    });

    // Send approval request email to admin (non-blocking — don't fail the
    // sign-up flow if the email fails to send)
    const firstName = user.firstName ?? "";
    const lastName  = user.lastName  ?? "";
    sendApprovalRequestEmail({ userId, firstName, lastName, email }).catch(
      (err: unknown) =>
        console.error("[set-pending] Failed to send approval email:", err)
    );

    return NextResponse.json({ status: "pending" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
