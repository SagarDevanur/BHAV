import { Sidebar } from "@/components/dashboard/sidebar";
import { UserHeader } from "@/components/dashboard/user-header";
import { AgentStatusIndicator } from "@/components/dashboard/agent-status-indicator";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Left sidebar — always dark, independent of color scheme */}
      <Sidebar />

      {/* Main content column */}
      <div className="flex flex-1 flex-col">
        {/* Top header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 dark:border-gray-800 dark:bg-gray-900">
          {/* Left: platform name */}
          <span className="text-sm font-semibold tracking-tight text-gray-900 dark:text-white">
            BHAV Acquisition Corp
          </span>

          {/* Right: agent status indicator + divider + user */}
          <div className="flex items-center gap-5">
            <AgentStatusIndicator />
            <div className="h-4 w-px bg-gray-200 dark:bg-gray-700" />
            <UserHeader />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-8">{children}</main>
      </div>
    </div>
  );
}
