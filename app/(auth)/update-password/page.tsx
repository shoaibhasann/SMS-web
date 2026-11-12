import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { createRecoveryClient, verifiedRecoverySession } from "@/lib/auth/recovery";
import { UpdatePasswordForm } from "./update-password-form";
import { listAuthenticators, readStaffMfaStatus } from "@/lib/auth/staff-mfa";

export default async function UpdatePasswordPage() {
  const recovery = await createRecoveryClient()
    .then(async ({ supabase }) => {
      const current = await verifiedRecoverySession(supabase);
      if (!current) return null;
      const security = await readStaffMfaStatus(supabase, current.userId);
      if (!security) return null;
      const factors = security.action === "challenge" ? await listAuthenticators(supabase) : [];
      return { ...current, needsMfa: !security.allowed, factors };
    })
    .catch(() => null);

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--bg)] p-4 sm:p-6">
      <div className="card w-full max-w-md p-5 sm:p-9">
        <div className="grid size-12 place-items-center rounded-2xl gradient"><ShieldCheck size={22} aria-hidden="true" /></div>
        <h1 className="mt-5 text-2xl font-black">{recovery ? "Set a new password" : "Open a password reset link"}</h1>
        {recovery ? (
          <>
            <p className="mt-2 break-words text-sm muted">Recovering {recovery.accountLabel}. Password recovery keeps your existing child links and authenticator.</p>
            <UpdatePasswordForm key={`${recovery.sessionId}:${recovery.needsMfa}:${recovery.factors.map(factor => factor.id).join(",")}`} sessionId={recovery.sessionId} mfaRequired={recovery.needsMfa} factors={recovery.factors} />
          </>
        ) : (
          <div className="mt-3 space-y-4">
            <p className="text-sm muted">Request a fresh reset link and open it in this browser to continue.</p>
            <Link href="/forgot-password" className="account-primary inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold">
              Request a reset link
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
