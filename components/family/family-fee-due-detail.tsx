"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadingState } from "@/components/ui/skeleton";
import { formatFeeMoney } from "@/lib/finance/fee-batches";
import { familyNotificationsHref, loadFamilyFeeDue, type FamilyNotificationRole } from "@/lib/notifications/family";
import { createClient } from "@/lib/supabase/client";

type Props = { feeId: string; studentId: string; role: FamilyNotificationRole; userId: string };
type Fee = NonNullable<Awaited<ReturnType<typeof loadFamilyFeeDue>>>;
type Result = { fee: Fee | null } | { error: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = "This fee is no longer available.";
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
});

export function FamilyFeeDueDetail({ feeId, studentId, role, userId }: Props) {
  const id = feeId.toLowerCase();
  const child = studentId.toLowerCase();
  return <FeeDueDetail key={`${role}:${userId}:${child}:${id}`} feeId={id} studentId={child} role={role} userId={userId} />;
}

function FeeDueDetail({ feeId, studentId, role, userId }: Props) {
  const [client] = useState(createClient);
  const [response, setResponse] = useState<{ attempt: number; result: Result }>();
  const [attempt, setAttempt] = useState(0);
  const [sessionChanged, setSessionChanged] = useState(false);
  const validTarget = uuid.test(feeId) && uuid.test(studentId);
  const result = response?.attempt === attempt ? response.result : undefined;

  useEffect(() => {
    if (!validTarget || sessionChanged) return;
    const controller = new AbortController();
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (!controller.signal.aborted && session?.user.id !== userId) {
        controller.abort();
        setSessionChanged(true);
      }
    });
    const refreshOnFocus = () => {
      if (document.visibilityState !== "hidden") setAttempt((value) => value + 1);
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);

    async function load() {
      try {
        const fee = await loadFamilyFeeDue(client, { id: feeId, studentId, userId, role }, controller.signal);
        if (!controller.signal.aborted) {
          setResponse({ attempt, result: { fee: fee?.id === feeId && fee.student_id === studentId ? fee : null } });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResponse({ attempt, result: { error: "This fee could not be loaded. Refresh to try again." } });
        }
      }
    }
    if (!controller.signal.aborted) void load();
    return () => {
      controller.abort();
      subscription.unsubscribe();
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [attempt, client, feeId, role, sessionChanged, studentId, userId, validTarget]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={familyNotificationsHref(role)}
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--primary)] hover:underline">
            <ArrowLeft size={16} aria-hidden="true" /> Back to notifications
          </Link>
          <h1 className="text-3xl font-black">Fee due</h1>
          <p className="mt-2 text-sm muted">Fee details from your notifications.</p>
        </div>
        {validTarget && !sessionChanged && (
          <button type="button" aria-label="Refresh fee details" disabled={!result}
            onClick={() => setAttempt((value) => value + 1)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold disabled:opacity-50">
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        )}
      </header>
      <section className="card min-w-0 overflow-hidden" aria-label="Requested fee" aria-busy={validTarget && !sessionChanged && !result}>
        {sessionChanged ? <p role="alert" className="p-5 text-sm muted">Your sign-in changed. Reopen this fee from Notifications.</p>
          : !validTarget ? <p className="p-5 text-sm muted">{unavailable}</p>
            : !result ? <LoadingState variant="form" label="Loading fee details…" className="p-5" />
              : "error" in result ? <p role="alert" className="p-5 text-sm text-red-700 dark:text-red-300">{result.error}</p>
                : result.fee ? <FeeSummary fee={result.fee} /> : <p className="p-5 text-sm muted">{unavailable}</p>}
      </section>
    </div>
  );
}

function FeeSummary({ fee }: { fee: Fee }) {
  return (
    <article className="min-w-0 space-y-4 break-words p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{fee.fee_name}</h2>
          <p className="mt-1 text-sm muted">{fee.student_name}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${fee.status === "overdue"
          ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-amber-500/10 text-amber-800 dark:text-amber-300"}`}>
          {fee.status === "overdue" ? "Overdue" : "Due"}
        </span>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div><dt className="font-semibold">Due date</dt><dd className="muted">
          <time dateTime={fee.due_date}>{dateFormat.format(new Date(`${fee.due_date}T00:00:00Z`))}</time>
        </dd></div>
        <div><dt className="font-semibold">Current balance</dt><dd className="font-bold tabular-nums">{formatFeeMoney(fee.balance)}</dd></div>
      </dl>
    </article>
  );
}
