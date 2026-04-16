import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isExceptionEmail } from "@/lib/auth-config";

/**
 * GET /api/pending-users
 *
 * Returns a list of users whose publicMetadata.pendingApproval === true.
 * Only callable by exception-list emails (co-founders / admin).
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = await clerkClient();

  // Verify caller is an admin (exception email)
  const caller = await client.users.getUser(userId);
  const callerEmail =
    caller.emailAddresses.find((e) => e.id === caller.primaryEmailAddressId)
      ?.emailAddress ?? "";

  if (!isExceptionEmail(callerEmail)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch all users and filter for pending
  const { data: users } = await client.users.getUserList({ limit: 200 });

  const pending = users
    .filter((u) => {
      const meta = u.publicMetadata as Record<string, unknown>;
      return meta.pendingApproval === true && meta.approved !== true;
    })
    .map((u) => ({
      id: u.id,
      firstName: u.firstName ?? "",
      lastName: u.lastName ?? "",
      email:
        u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)
          ?.emailAddress ?? "",
      createdAt: u.createdAt,
    }));

  return NextResponse.json({ users: pending });
}
