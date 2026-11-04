import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { RequestPasswordResetForm } from "./request-password-reset-form";

export default async function ForgotPasswordPage({ searchParams }: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] p-6">
      <div className="card w-full max-w-md p-7 sm:p-9">
        <Link href="/login" className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-blue-600">
          <ArrowLeft size={16} aria-hidden="true" /> Back to login
        </Link>
        <div className="grid size-12 place-items-center rounded-2xl gradient"><ShieldCheck size={22} aria-hidden="true" /></div>
        <h1 className="mt-5 text-2xl font-black">Reset your password</h1>
        <p className="mt-2 text-sm muted">Enter the email address on your school account.</p>
        {error === "invalid_recovery" && (
          <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-400">
            That reset link could not be opened. Request a new link and open it in this browser.
          </p>
        )}
        <RequestPasswordResetForm />
      </div>
    </main>
  );
}
