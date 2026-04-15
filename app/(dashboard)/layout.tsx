import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isEmailAllowed } from "@/lib/auth-config";
import { Sidebar } from "@/components/dashboard/sidebar";
import { UserHeader } from "@/components/dashboard/user-header";
import { AgentStatusIndicator } from "@/components/dashboard/agent-status-indicator";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // currentUser() is safe to call in server components and layouts.
  // Middleware already ensures an authenticated session exists before
  // this layout runs, so null here means the session is stale/invalid.
  const user = await currentUser();

  if (!user) {
    redirect("/sign-in");
  }

  // Find the primary email address
  const email =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress ?? "";

  // Domain / exception-list check — redirect unauthorized accounts
  if (!isEmailAllowed(email)) {
    redirect("/unauthorized");
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
          <AgentStatusIndicator />
          <UserHeader />
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-8">{children}</main>
      </div>
    </div>
  );
}
