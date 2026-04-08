import Link from "next/link";

// Sign-up is disabled. BHAV has exactly two co-founder accounts, created manually.
// This page exists so Clerk redirect URLs resolve without a 404.
export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="max-w-sm w-full rounded-xl border border-gray-200 bg-white p-8 shadow-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
          <svg
            className="h-6 w-6 text-gray-500"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
            />
          </svg>
        </div>
        <h1 className="text-lg font-semibold text-gray-900">Access restricted</h1>
        <p className="mt-2 text-sm text-gray-500">
          BHAV Acquisition Corp is a private platform. New accounts are provisioned
          by the co-founders only.
        </p>
        <p className="mt-3 text-sm text-gray-500">
          Contact{" "}
          <a href="mailto:admin@bhavacq.com" className="text-blue-600 hover:underline">
            admin@bhavacq.com
          </a>{" "}
          if you believe you should have access.
        </p>
        <Link
          href="/sign-in"
          className="mt-6 inline-block text-sm font-medium text-blue-600 hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
