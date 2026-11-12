import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { RequestPasswordResetForm } from "./request-password-reset-form";

export default async function ForgotPasswordPage({ searchParams }: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--bg)] p-4 sm:p-6">
      <div className="card w-full max-w-md p-5 sm:p-9">
        <Link href="/login" className="mb-8 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--primary)]">
          <ArrowLeft size={16} aria-hidden="true" /> Back to sign in
        </Link>
        <div className="grid size-12 place-items-center rounded-2xl gradient"><ShieldCheck size={22} aria-hidden="true" /></div>
        <h1 className="mt-5 text-2xl font-black">Reset your password</h1>
        <p className="mt-2 text-sm muted">Enter the email address on your school account.</p>
        {error === "invalid_recovery" && (
          <p role="alert" className="login-error mt-4">
            That reset link could not be opened. Request a new link and open it in this browser.
          </p>
        )}
        <RequestPasswordResetForm />
      </div>
    </main>
  );
}
