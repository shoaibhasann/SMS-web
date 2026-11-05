"use client";

import { useEffect, useState } from "react";
import { RefreshCw, WalletCards } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { loadFamilyStudents, rememberFamilyChild, restoreFamilyChild, type FamilyStudent } from "@/lib/attendance/family";
import { studentName } from "@/lib/attendance/types";
import { getFamilyStudentCredit, type CreditActivityKind, type FamilyCreditAccount } from "@/lib/finance/advance-credit";
import { formatMoney } from "@/lib/finance/money";
import { manualPaymentLabel } from "@/lib/finance/payment-methods";

const pageSize = 30;
const dateLabel = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const buttonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
export const creditActivityLabels: Record<CreditActivityKind, string> = {
  receipt: "Advance received", allocation: "Applied to fee", allocation_return: "Returned to advance",
  refund: "Offline refund recorded", receipt_reversal: "Advance entry corrected",
};

export function FamilyAdvanceCredit({ role, userId }: { role: "parent" | "student"; userId: string }) {
  const [client] = useState(createClient);
  const [students, setStudents] = useState<FamilyStudent[]>();
  const [selectedId, setSelectedId] = useState("");
  const [accessError, setAccessError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [sessionChanged, setSessionChanged] = useState(false);
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);
  useEffect(() => {
    if (sessionChanged) return;
    let active = true;
    loadFamilyStudents(client, role, userId).then((linked) => {
      if (!active) return;
      setStudents(linked);
      setSelectedId(role === "parent" ? restoreFamilyChild(userId, linked) : linked[0]?.id ?? "");
    }, () => { if (active) setAccessError(true); });
    return () => { active = false; };
  }, [attempt, client, role, sessionChanged, userId]);
  const student = students?.find((item) => item.id === selectedId);
  return <div className="space-y-5">
    <header><p className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-blue-700 dark:text-blue-300"><WalletCards size={15} aria-hidden="true" /> School advance account</p>
      <h1 className="text-3xl font-black">Advance credit</h1><p className="mt-2 max-w-2xl text-sm muted">See retained advance funds, fee applications and refunds recorded by the school. Advance stays separate from unpaid fees until the office applies it.</p></header>
    {sessionChanged ? <p role="alert" className="card p-5 text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reload to verify advance account access.</p>
      : accessError ? <div className="card space-y-3 p-5"><p role="alert" className="text-sm text-red-700 dark:text-red-300">The students linked to this account could not be verified.</p><button type="button" className={buttonClass} onClick={() => { setAccessError(false); setAttempt((value) => value + 1); }}>Retry access check</button></div>
        : !students ? <p role="status" className="text-sm muted">Checking advance account access…</p>
          : !student ? <p className="card p-5 text-sm muted">No student is linked to this account.</p> : <>
            {role === "parent" && <label className="card block space-y-2 p-5 text-sm font-semibold"><span>Select child</span><select className="field max-w-xl" value={selectedId} onChange={(event) => {
              if (!students.some((item) => item.id === event.target.value)) return;
              setSelectedId(event.target.value); rememberFamilyChild(userId, event.target.value);
            }}>{students.map((item) => <option key={item.id} value={item.id}>{studentName(item)} · {item.admission_no}</option>)}</select></label>}
            <FamilyCreditStatement key={student.id} client={client} student={student} />
          </>}
  </div>;
}

function FamilyCreditStatement({ client, student }: { client: ReturnType<typeof createClient>; student: FamilyStudent }) {
  const [page, setPage] = useState(0), [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ page: number; attempt: number; account: FamilyCreditAccount | null; failed: boolean }>();
  const view = result?.page === page && result.attempt === attempt ? result : undefined;
  useEffect(() => {
    let active = true;
    getFamilyStudentCredit(client, student.id, pageSize, page * pageSize).then((account) => {
      if (active && account.school_id === student.school_id) setResult({ page, attempt, account, failed: false });
      else if (active) setResult({ page, attempt, account: null, failed: true });
    }, () => { if (active) setResult({ page, attempt, account: null, failed: true }); });
    return () => { active = false; };
  }, [attempt, client, page, student]);
  const account = view?.account, summary = account?.summary;
  return <section className="card overflow-hidden" aria-label="Advance credit statement" aria-busy={!view}>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-5"><div><h2 className="font-bold">{studentName(student)}</h2><p className="mt-1 text-sm muted">{student.admission_no} · All retained sessions</p></div><button type="button" className={buttonClass} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" /> Refresh advance account</button></header>
    {!view ? <p role="status" className="p-5 text-sm muted">Loading the saved advance statement…</p>
      : view.failed || !account || !summary ? <div className="space-y-3 p-5"><p role="alert" className="text-sm text-red-700 dark:text-red-300">Advance records could not be loaded. Refresh to verify the saved account.</p></div> : <>
        {summary.invalid && <p role="alert" className="m-5 rounded-xl bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">This advance account needs reconciliation by the school. Unverified balances are unavailable.</p>}
        <dl className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">{([
          ["Available advance", summary.available_amount], ["Reserved for approved refund", summary.reserved_amount],
          ["Net applied to fees", summary.allocated_amount], ["Refunds recorded", summary.refunded_amount],
        ] as const).map(([label, amount]) => <div key={label} className="min-w-0 rounded-xl bg-[var(--surface-2)] p-4"><dt className="text-xs muted">{label}</dt><dd className="mt-2 break-words text-xl font-bold tabular-nums">{amount === null ? "Needs review" : formatMoney(amount)}</dd></div>)}</dl>
        <p className="px-5 pb-5 text-xs muted">A reserved refund is awaiting an offline payout record. Only “Offline refund recorded” confirms that the school recorded a completed payout. Contact the school about settlement details.</p>
        <div className="border-t border-[var(--border)] p-5"><h3 className="font-bold">Advance activity</h3><p className="mt-1 text-xs muted">Showing {account.activities.length} of {account.activity_count} saved entries.</p></div>
        {!account.activities.length ? <p className="px-5 pb-5 text-sm muted">No advance activity on this page.</p> : <ul aria-label="Advance activity" className="divide-y divide-[var(--border)]">{account.activities.map((entry) => {
          const incoming = entry.kind === "receipt" || entry.kind === "allocation_return";
          return <li key={entry.id} className="space-y-2 p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="font-semibold">{creditActivityLabels[entry.kind]}</h4><p className="mt-1 text-xs muted">{dateLabel.format(new Date(entry.occurred_at))} IST{entry.payment_method && ` · ${manualPaymentLabel(entry.payment_method)}`}</p></div><p className={`shrink-0 font-bold tabular-nums ${incoming ? "text-emerald-700 dark:text-emerald-300" : ""}`}>{incoming ? "+" : "−"}{formatMoney(entry.amount)}</p></div>
            {entry.fee_name && <p className="break-words text-sm muted">{entry.fee_name}</p>}<p className="break-all font-mono text-xs">{entry.reference}</p>{entry.related_reference && <p className="break-all text-xs muted">Related reference · {entry.related_reference}</p>}
            {entry.kind === "receipt_reversal" && <p className="text-xs muted">A correction to a recorded advance entry. This does not initiate a bank refund.</p>}
          </li>;
        })}</ul>}
        {(page > 0 || account.activity_count > pageSize) && <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] p-5"><button type="button" className={buttonClass} disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous activity</button><button type="button" className={buttonClass} disabled={(page + 1) * pageSize >= account.activity_count} onClick={() => setPage((value) => value + 1)}>Next activity</button></footer>}
      </>}
  </section>;
}
