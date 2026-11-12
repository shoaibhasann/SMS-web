"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { FamilyReceiptDetails } from "@/components/finance/family-receipt-details";
import { LoadingState } from "@/components/ui/skeleton";
import { formatFeeMoney } from "@/lib/finance/fee-batches";
import { familyNotificationsHref, loadFamilyFeeDue, loadFamilyFeePayment, type FamilyNotificationRole } from "@/lib/notifications/family";
import { createClient } from "@/lib/supabase/client";

type FamilyProps = { studentId: string; role: FamilyNotificationRole; userId: string };
type TargetProps = FamilyProps & { id: string; kind: "due" | "payment" };
type Fee = NonNullable<Awaited<ReturnType<typeof loadFamilyFeeDue>>>;
type Payment = NonNullable<Awaited<ReturnType<typeof loadFamilyFeePayment>>>;
type Result = { kind: "due"; record: Fee | null } | { kind: "payment"; record: Payment | null } | { error: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const detailCopy = {
  due: { item: "fee", title: "Fee due", description: "Fee details", subtitle: "Details of the fee due for your child.", region: "Requested fee", refresh: "Refresh fee details" },
  payment: { item: "payment receipt", title: "Fee payment", description: "Payment receipt", subtitle: "Receipt for a fee payment.", region: "Requested payment receipt", refresh: "Refresh payment receipt" },
};
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
});

export function FamilyFeeDueDetail({ feeId, ...family }: FamilyProps & { feeId: string }) {
  return <ExactFeeDetail {...family} id={feeId} kind="due" />;
}

export function FamilyFeePaymentDetail({ paymentId, ...family }: FamilyProps & { paymentId: string }) {
  return <ExactFeeDetail {...family} id={paymentId} kind="payment" />;
}

function ExactFeeDetail({ id, kind, studentId, role, userId }: TargetProps) {
  const target = id.toLowerCase();
  const child = studentId.toLowerCase();
  return <FeeDetail key={`${kind}:${role}:${userId}:${child}:${target}`}
    id={target} kind={kind} studentId={child} role={role} userId={userId} />;
}

function FeeDetail({ id, kind, studentId, role, userId }: TargetProps) {
  const [client] = useState(createClient);
  const [response, setResponse] = useState<{ attempt: number; result: Result }>();
  const [attempt, setAttempt] = useState(0);
  const [sessionChanged, setSessionChanged] = useState(false);
  const validTarget = uuid.test(id) && uuid.test(studentId);
  const result = response?.attempt === attempt ? response.result : undefined;
  const { item, title, description, subtitle, region, refresh } = detailCopy[kind];
  const unavailable = `This ${item} is no longer available.`;

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
        const options = { id, studentId, userId, role };
        const target: Result = kind === "due"
          ? { kind, record: await loadFamilyFeeDue(client, options, controller.signal) }
          : { kind, record: await loadFamilyFeePayment(client, options, controller.signal) };
        if (!controller.signal.aborted) {
          const matches = target.record?.id === id && target.record.student_id === studentId;
          setResponse({ attempt, result: matches ? target : { kind, record: null } });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResponse({ attempt, result: { error: `This ${item} could not be loaded. Refresh to try again.` } });
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
  }, [attempt, client, id, item, kind, role, sessionChanged, studentId, userId, validTarget]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={familyNotificationsHref(role)}
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--primary)] hover:underline">
            <ArrowLeft size={16} aria-hidden="true" /> Back to notifications
          </Link>
          <h1 className="text-3xl font-black">{title}</h1>
          <p className="mt-2 text-sm muted">{subtitle}</p>
        </div>
        {validTarget && !sessionChanged && (
          <button type="button" aria-label={refresh} disabled={!result}
            onClick={() => setAttempt((value) => value + 1)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold disabled:opacity-50">
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        )}
      </header>
      <section className="card min-w-0 overflow-hidden" aria-label={region} aria-busy={validTarget && !sessionChanged && !result}>
        {sessionChanged ? <p role="alert" className="p-5 text-sm muted">Your sign-in changed. Reopen this {item} from Notifications.</p>
          : !validTarget ? <p className="p-5 text-sm muted">{unavailable}</p>
            : !result ? <LoadingState variant="form" label={`Loading ${description.toLowerCase()}…`} className="p-5" />
              : "error" in result ? <div className="space-y-3 p-5"><p role="alert" className="text-sm text-danger">{result.error}</p>
                <button type="button" className="btn btn-secondary" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>
                : !result.record ? <p className="p-5 text-sm muted">{unavailable}</p>
                  : result.kind === "due" ? <FeeSummary fee={result.record} /> : <PaymentSummary payment={result.record} />}
      </section>
    </div>
  );
}

function PaymentSummary({ payment }: { payment: Payment }) {
  return (
    <article className="min-w-0 space-y-4 break-words p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold">{payment.fee_name}</h2>
          <p className="mt-1 text-sm muted">{payment.student_name}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${payment.status === "reversed"
          ? "bg-amber-500/10 text-amber-800 dark:text-amber-300" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>
          {payment.status === "reversed" ? "Reversed" : "Paid"}
        </span>
      </div>
      <FamilyReceiptDetails receipt={payment} />
    </article>
  );
}

function FeeSummary({ fee }: { fee: Fee }) {
  return (
    <article className="min-w-0 space-y-4 break-words p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
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
        <div><dt className="font-semibold">Balance due</dt><dd className="text-2xl font-bold tabular-nums">{formatFeeMoney(fee.balance)}</dd></div>
      </dl>
    </article>
  );
}
