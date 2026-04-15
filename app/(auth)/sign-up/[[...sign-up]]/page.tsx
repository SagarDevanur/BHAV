"use client";

import { useSignUp } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ALLOWED_DOMAIN, EXCEPTION_EMAILS, isEmailAllowed, isExceptionEmail } from "@/lib/auth-config";

// ---------------------------------------------------------------------------
// Shared design primitives
// ---------------------------------------------------------------------------

function BhavLogo() {
  return (
    <div className="flex flex-col items-center gap-3">
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
  );
}

function InputField({
  id,
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
        className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verification step — enter the 6-digit email code
// ---------------------------------------------------------------------------

function VerifyView({
  email,
  isException,
  onBack,
}: {
  email: string;
  isException: boolean;
  onBack: () => void;
}) {
  const { isLoaded, signUp, setActive } = useSignUp();
  const router  = useRouter();
  const [code, setCode]     = useState("");
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone]     = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setError("");
    setLoading(true);

    try {
      const result = await signUp.attemptEmailAddressVerification({ code });

      if (result.status === "complete") {
        if (isException) {
          // Exception emails go straight to dashboard
          await setActive({ session: result.createdSessionId });
          router.push("/dashboard");
        } else {
          // @bhavspac.com users: verify then show success (admin is notified separately)
          setDone(true);
        }
      } else {
        setError("Verification could not be completed. Please try again.");
      }
    } catch (err: unknown) {
      const e = err as { errors?: Array<{ longMessage?: string; message?: string }> };
      setError(
        e.errors?.[0]?.longMessage ??
        e.errors?.[0]?.message ??
        "Invalid or expired code."
      );
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-5 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 border border-emerald-200">
          <svg className="h-6 w-6 text-emerald-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <div>
          <p className="text-base font-semibold text-slate-900">Access request submitted.</p>
          <p className="mt-1.5 text-sm text-slate-500">
            You will receive an email confirmation shortly.
          </p>
        </div>
        <Link
          href="/sign-in"
          className="mt-2 text-sm font-medium text-blue-700 hover:text-blue-900 transition"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <p className="text-center text-sm text-slate-600">
        A 6-digit code was sent to{" "}
        <span className="font-medium text-slate-800">{email}</span>.
        <br />Enter it below to verify your account.
      </p>

      <InputField
        id="verify-code"
        label="Verification code"
        type="text"
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
        placeholder="123456"
      />

      {error && (
        <p className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:opacity-60"
      >
        {loading ? "Verifying…" : "Verify Email"}
      </button>

      <button
        type="button"
        onClick={onBack}
        className="text-center text-sm font-medium text-slate-500 hover:text-slate-700 transition"
      >
        ← Use a different email
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sign-up form
// ---------------------------------------------------------------------------

function SignUpForm({
  onVerify,
}: {
  onVerify: (email: string, isException: boolean) => void;
}) {
  const { isLoaded, signUp } = useSignUp();
  const [firstName, setFirstName]   = useState("");
  const [lastName, setLastName]     = useState("");
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");
  const [confirm, setConfirm]       = useState("");
  const [error, setError]           = useState("");
  const [loading, setLoading]       = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setError("");

    // Client-side domain validation
    if (!isEmailAllowed(email)) {
      setError(
        "Access restricted to authorised users only. Contact your administrator."
      );
      return;
    }

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);

    try {
      await signUp.create({
        emailAddress: email,
        password,
        firstName,
        lastName,
      });

      // Send verification code to email
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });

      onVerify(email, isExceptionEmail(email));
    } catch (err: unknown) {
      const e = err as { errors?: Array<{ longMessage?: string; message?: string; code?: string }> };
      const code = e.errors?.[0]?.code ?? "";

      if (code === "form_identifier_exists") {
        setError("An account with this email already exists. Please sign in instead.");
      } else {
        setError(
          e.errors?.[0]?.longMessage ??
          e.errors?.[0]?.message ??
          "Could not create account. Please try again."
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <InputField
          id="first-name"
          label="First name"
          value={firstName}
          onChange={setFirstName}
          autoComplete="given-name"
          placeholder="Jane"
        />
        <InputField
          id="last-name"
          label="Last name"
          value={lastName}
          onChange={setLastName}
          autoComplete="family-name"
          placeholder="Smith"
        />
      </div>

      <InputField
        id="email"
        label="Work email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        placeholder={`you@${ALLOWED_DOMAIN}`}
      />

      <InputField
        id="password"
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />

      <InputField
        id="confirm-password"
        label="Confirm password"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />

      {error && (
        <p className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="mt-1 w-full rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {loading ? "Submitting…" : "Request Access"}
      </button>

      <p className="text-center text-sm text-slate-500">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-blue-700 hover:text-blue-900 transition">
          Sign in
        </Link>
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Page — composes form + verification steps
// ---------------------------------------------------------------------------

// Suppress unused-import warning: EXCEPTION_EMAILS is used in type annotation context
void EXCEPTION_EMAILS;

type Step = "form" | "verify";

export default function SignUpPage() {
  const [step, setStep]           = useState<Step>("form");
  const [pendingEmail, setPendingEmail] = useState("");
  const [pendingIsException, setPendingIsException] = useState(false);

  const titles: Record<Step, string> = {
    form:   "Request access",
    verify: "Verify your email",
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <BhavLogo />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white px-8 py-8 shadow-sm">
          <h1 className="mb-6 text-center text-base font-semibold text-slate-800">
            {titles[step]}
          </h1>

          {step === "form" && (
            <SignUpForm
              onVerify={(email, isException) => {
                setPendingEmail(email);
                setPendingIsException(isException);
                setStep("verify");
              }}
            />
          )}

          {step === "verify" && (
            <VerifyView
              email={pendingEmail}
              isException={pendingIsException}
              onBack={() => setStep("form")}
            />
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          © {new Date().getFullYear()} BHAV Acquisition Corp. All rights reserved.
        </p>
      </div>
    </main>
  );
}
