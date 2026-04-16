import { currentUser } from "@clerk/nextjs/server";
import { isExceptionEmail } from "@/lib/auth-config";
import { PendingUsersPanel } from "@/components/dashboard/pending-users-panel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentUser();
  const email =
    user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress ?? "";

  const isAdmin = isExceptionEmail(email);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-slate-900 mb-8">Settings</h1>

      {isAdmin && (
        <section>
          <h2 className="text-base font-semibold text-slate-800 mb-1">
            User Approvals
          </h2>
          <p className="text-sm text-slate-500 mb-4">
            Review and approve access requests from @bhavspac.com users.
          </p>
          <PendingUsersPanel />
        </section>
      )}

      {!isAdmin && (
        <p className="text-sm text-slate-500">No settings available for your account.</p>
      )}
    </div>
  );
}
