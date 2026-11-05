import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { createRecoveryClient, verifiedRecoverySession } from "@/lib/auth/recovery";
import { UpdatePasswordForm } from "./update-password-form";

export default async function UpdatePasswordPage() {
  const recovery = await createRecoveryClient()
    .then(({ supabase }) => verifiedRecoverySession(supabase))
    .catch(() => null);

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] p-6">
      <div className="card w-full max-w-md p-7 sm:p-9">
        <div className="grid size-12 place-items-center rounded-2xl gradient"><ShieldCheck size={22} aria-hidden="true" /></div>
        <h1 className="mt-5 text-2xl font-black">{recovery ? "Set a new password" : "Open a password reset link"}</h1>
        {recovery ? (
          <>
            <p className="mt-2 text-sm muted">Choose a strong password for your SMS account.</p>
            <UpdatePasswordForm sessionId={recovery.sessionId} />
          </>
        ) : (
          <div className="mt-3 space-y-4">
            <p className="text-sm muted">Request a fresh reset link and open it in this browser to continue.</p>
            <Link href="/forgot-password" className="inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white">
              Request a reset link
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
