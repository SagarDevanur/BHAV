import { SignOutButton } from "@clerk/nextjs";

export const metadata = {
  title: "Access Pending — BHAV Acquisition Corp",
};

export default function PendingApprovalPage() {
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

        {/* Card */}
        <div className="rounded-2xl border border-slate-200 bg-white px-8 py-8 shadow-sm text-center">
          {/* Clock icon */}
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 border border-amber-100">
            <svg
              className="h-5 w-5 text-amber-500"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z"
              />
            </svg>
          </div>

          <h1 className="text-base font-semibold text-slate-900">Access Pending Approval</h1>
          <p className="mt-2 text-sm text-slate-500 leading-relaxed">
            Your account is awaiting admin approval. You will be able to access
            the dashboard once an administrator reviews your request.
          </p>

          <div className="mt-6 flex flex-col gap-3">
            <SignOutButton redirectUrl="/sign-in">
              <button className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                </svg>
                Sign Out
              </button>
            </SignOutButton>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          © {new Date().getFullYear()} BHAV Acquisition Corp. All rights reserved.
        </p>
      </div>
    </main>
  );
}
