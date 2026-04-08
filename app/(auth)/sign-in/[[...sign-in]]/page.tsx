import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">BHAV Acquisition Corp</h1>
          <p className="mt-1 text-sm text-gray-500">Internal deal platform — authorised access only</p>
        </div>
        <SignIn
          appearance={{
            elements: {
              // Hide the "Don't have an account? Sign up" footer link
              footerAction: "hidden",
            },
          }}
        />
      </div>
    </main>
  );
}
