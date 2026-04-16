import { currentUser } from "@clerk/nextjs/server";
import { clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { verifyApprovalToken } from "@/lib/approval-token";
import { isExceptionEmail } from "@/lib/auth-config";

interface Props {
  searchParams: Promise<{ token?: string }>;
}

export const metadata = {
  title: "Approve Access — BHAV Acquisition Corp",
};

export default async function ApprovePage({ searchParams }: Props) {
  const { token } = await searchParams;

  // Validate token
  if (!token) {
    return <ApproveResult status="invalid" />;
  }

  const userId = verifyApprovalToken(token);
  if (!userId) {
    return <ApproveResult status="expired" />;
  }

  // Check if the person clicking the link is logged in and is an admin
  const caller = await currentUser();
  if (!caller) {
    // Redirect to sign-in, then back here after login
    redirect(`/sign-in?redirect_url=/approve?token=${token}`);
  }

  const callerEmail =
    caller.emailAddresses.find((e) => e.id === caller.primaryEmailAddressId)
      ?.emailAddress ?? "";

  if (!isExceptionEmail(callerEmail)) {
    return <ApproveResult status="forbidden" />;
  }

  // Look up the target user
  const client = await clerkClient();
  let targetName = "";
  let targetEmail = "";

  try {
    const target = await client.users.getUser(userId);
    const meta = target.publicMetadata as Record<string, unknown>;

    // Already approved
    if (meta.approved === true) {
      return <ApproveResult status="already_approved" />;
    }

    targetEmail =
      target.emailAddresses.find((e) => e.id === target.primaryEmailAddressId)
        ?.emailAddress ?? "";
    targetName =
      `${target.firstName ?? ""} ${target.lastName ?? ""}`.trim() || targetEmail;

    // Approve the user
    await client.users.updateUserMetadata(userId, {
      publicMetadata: { ...meta, approved: true, pendingApproval: false },
    });
  } catch {
    return <ApproveResult status="error" />;
  }

  return <ApproveResult status="success" name={targetName} email={targetEmail} />;
}

// ---------------------------------------------------------------------------
// Result UI
// ---------------------------------------------------------------------------

function ApproveResult({
  status,
  name,
  email,
}: {
  status: "success" | "already_approved" | "invalid" | "expired" | "forbidden" | "error";
  name?: string;
  email?: string;
}) {
  const config: Record<
    typeof status,
    { icon: string; color: string; bg: string; border: string; title: string; body: string }
  > = {
    success: {
      icon: "M4.5 12.75l6 6 9-13.5",
      color: "text-emerald-500",
      bg: "bg-emerald-50",
      border: "border-emerald-100",
      title: "Access approved",
      body: `${name ?? email ?? "The user"} can now sign in to the BHAV dashboard.`,
    },
    already_approved: {
      icon: "M4.5 12.75l6 6 9-13.5",
      color: "text-emerald-500",
      bg: "bg-emerald-50",
      border: "border-emerald-100",
      title: "Already approved",
      body: "This user already has access to the dashboard.",
    },
    invalid: {
      icon: "M6 18L18 6M6 6l12 12",
      color: "text-red-500",
      bg: "bg-red-50",
      border: "border-red-100",
      title: "Invalid link",
      body: "This approval link is not valid.",
    },
    expired: {
      icon: "M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z",
      color: "text-amber-500",
      bg: "bg-amber-50",
      border: "border-amber-100",
      title: "Link expired",
      body: "This approval link has expired (7 days). The user can sign up again to receive a new link.",
    },
    forbidden: {
      icon: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z",
      color: "text-red-500",
      bg: "bg-red-50",
      border: "border-red-100",
      title: "Not authorised",
      body: "Only BHAV administrators can approve access requests.",
    },
    error: {
      icon: "M6 18L18 6M6 6l12 12",
      color: "text-red-500",
      bg: "bg-red-50",
      border: "border-red-100",
      title: "Something went wrong",
      body: "Could not process the approval. Please try again or approve from the Settings page.",
    },
  };

  const c = config[status];

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-900">
            <span className="text-xl font-bold tracking-tight text-white">B</span>
          </div>
          <div className="text-center">
            <p className="text-xl font-semibold text-slate-900">BHAV Acquisition Corp</p>
            <p className="mt-0.5 text-sm font-medium tracking-wide text-slate-500">
              AI-Native deSPAC Engine
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white px-8 py-8 shadow-sm text-center">
          <div className={`mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full ${c.bg} border ${c.border}`}>
            <svg className={`h-5 w-5 ${c.color}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d={c.icon} />
            </svg>
          </div>
          <h1 className="text-base font-semibold text-slate-900">{c.title}</h1>
          <p className="mt-2 text-sm text-slate-500 leading-relaxed">{c.body}</p>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          © {new Date().getFullYear()} BHAV Acquisition Corp. All rights reserved.
        </p>
      </div>
    </main>
  );
}
