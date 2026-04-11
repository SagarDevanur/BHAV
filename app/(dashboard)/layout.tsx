import { Sidebar } from "@/components/dashboard/sidebar";
import { UserHeader } from "@/components/dashboard/user-header";
import { AgentStatusIndicator } from "@/components/dashboard/agent-status-indicator";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
