"use client";

import { useSignIn } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";

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
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  type: string;
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
// Sign-in view
// ---------------------------------------------------------------------------

function SignInView({
  onForgotPassword,
}: {
  onForgotPassword: () => void;
}) {
  const { isLoaded, signIn, setActive } = useSignIn();
  const router = useRouter();
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setError("");
    setLoading(true);

    try {
      const result = await signIn.create({ identifier: email, password });

      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.push("/dashboard");
      } else {
        setError("Sign in could not be completed. Please try again.");
      }
    } catch (err: unknown) {
      const e = err as { errors?: Array<{ longMessage?: string; message?: string }> };
      const msg =
        e.errors?.[0]?.longMessage ??
        e.errors?.[0]?.message ??
        "Incorrect email or password.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <InputField
        id="email"
        label="Email address"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        placeholder="you@bhavspac.com"
      />

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="password" className="text-sm font-medium text-slate-700">
            Password
          </label>
          <button
            type="button"
            onClick={onForgotPassword}
            className="text-xs font-medium text-blue-700 hover:text-blue-900 transition"
          >
            Forgot password?
          </button>
        </div>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10"
        />
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {loading ? "Signing in…" : "Sign In"}
      </button>

      <p className="text-center text-sm text-slate-500">
        Don&apos;t have an account?{" "}
        <Link href="/sign-up" className="font-medium text-blue-700 hover:text-blue-900 transition">
          Request Access
        </Link>
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Forgot-password: step 1 — enter email
// ---------------------------------------------------------------------------

function ForgotEmailView({
  onBack,
  onCodeSent,
}: {
  onBack: () => void;
  onCodeSent: (email: string) => void;
}) {
  const { isLoaded, signIn } = useSignIn();
  const [email, setEmail]   = useState("");
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setError("");
    setLoading(true);

    try {
      await signIn.create({
        strategy: "reset_password_email_code",
        identifier: email,
      });
      onCodeSent(email);
    } catch {
      // Always show "sent" regardless — prevents email enumeration
      onCodeSent(email);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="text-center">
        <p className="text-sm text-slate-600">
          Enter your email address and we&apos;ll send you a reset code.
        </p>
      </div>

      <InputField
        id="forgot-email"
        label="Email address"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        placeholder="you@bhavspac.com"
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
        {loading ? "Sending…" : "Send Reset Code"}
      </button>

      <button
        type="button"
        onClick={onBack}
        className="text-center text-sm font-medium text-slate-500 hover:text-slate-700 transition"
      >
        ← Back to sign in
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Forgot-password: step 2 — enter code + new password
// ---------------------------------------------------------------------------

function ForgotResetView({
  email,
  onBack,
  onSuccess,
}: {
  email: string;
  onBack: () => void;
  onSuccess: () => void;
}) {
  const { isLoaded, signIn, setActive } = useSignIn();
  const router = useRouter();
  const [code, setCode]               = useState("");
  const [password, setPassword]       = useState("");
  const [confirm, setConfirm]         = useState("");
  const [error, setError]             = useState("");
  const [loading, setLoading]         = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    if (password !== confirm) { setError("Passwords do not match."); return; }
    if (password.length < 8)  { setError("Password must be at least 8 characters."); return; }
    setError("");
    setLoading(true);

    try {
      const attempt = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code,
      });

      if (attempt.status === "needs_new_password") {
        const result = await signIn.resetPassword({ password });
        if (result.status === "complete") {
          await setActive({ session: result.createdSessionId });
          router.push("/dashboard");
        }
      }
      onSuccess();
    } catch (err: unknown) {
      const e = err as { errors?: Array<{ longMessage?: string; message?: string }> };
      setError(
        e.errors?.[0]?.longMessage ??
        e.errors?.[0]?.message ??
        "Invalid code or the code has expired."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <p className="text-center text-sm text-slate-600">
        A 6-digit code was sent to <span className="font-medium text-slate-800">{email}</span>.
      </p>

      <InputField
        id="reset-code"
        label="Reset code"
        type="text"
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
        placeholder="123456"
      />
      <InputField
        id="new-password"
        label="New password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />
      <InputField
        id="confirm-new-password"
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
        className="w-full rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:opacity-60"
      >
        {loading ? "Resetting…" : "Reset Password"}
      </button>

      <button
        type="button"
        onClick={onBack}
        className="text-center text-sm font-medium text-slate-500 hover:text-slate-700 transition"
      >
        ← Back to sign in
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Step = "signin" | "forgot-email" | "forgot-reset";

export default function SignInPage() {
  const [step, setStep]         = useState<Step>("signin");
  const [resetEmail, setResetEmail] = useState("");

  const titles: Record<Step, string> = {
    "signin":       "Sign in to your account",
    "forgot-email": "Reset your password",
    "forgot-reset": "Choose a new password",
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

          {step === "signin" && (
            <SignInView onForgotPassword={() => setStep("forgot-email")} />
          )}

          {step === "forgot-email" && (
            <ForgotEmailView
              onBack={() => setStep("signin")}
              onCodeSent={(email) => {
                setResetEmail(email);
                setStep("forgot-reset");
              }}
            />
          )}

          {step === "forgot-reset" && (
            <ForgotResetView
              email={resetEmail}
              onBack={() => setStep("signin")}
              onSuccess={() => setStep("signin")}
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
