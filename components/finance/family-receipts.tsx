"use client";

import { useEffect, useState } from "react";
import { loadFamilyStudents, rememberFamilyChild, restoreFamilyChild, type FamilyStudent } from "@/lib/attendance/family";
import { studentName } from "@/lib/attendance/types";
import { createClient } from "@/lib/supabase/client";
import { listFamilyFeeReceipts, type FamilyFeeReceipt } from "@/lib/finance/fee-changes";
import { formatFeeMoney } from "@/lib/finance/fee-batches";
import { LoadingState } from "@/components/ui/skeleton";

const pageSize = 30;
const paidDate = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const button = "rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-60";

export function FamilyReceipts({ role, userId }: { role: "student" | "parent"; userId: string }) {
  const [client] = useState(createClient);
  const [students, setStudents] = useState<FamilyStudent[]>();
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
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
    }, () => {
      if (active) setError("Could not load the students linked to this account.");
    });
    return () => { active = false; };
  }, [attempt, client, role, sessionChanged, userId]);

  const student = students?.find((item) => item.id === selectedId);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-3xl font-black">Fee receipts</h1>
        <p className="mt-2 text-sm muted">{role === "parent"
          ? "View recorded payments for your linked children."
          : "View your recorded payments."}</p>
      </header>
      {sessionChanged ? <p role="alert" className="text-sm text-red-600">Your sign-in changed. Refresh to check access.</p>
        : error ? (
          <div className="card space-y-3 p-4">
            <p role="alert" className="text-sm text-red-600">{error}</p>
            <button type="button" className={button} onClick={() => {
              setError("");
              setAttempt((count) => count + 1);
            }}>Retry access check</button>
          </div>
        ) : !students ? <LoadingState variant="form" className="text-sm muted">Checking receipt access…</LoadingState>
          : !student ? <p className="card p-4 text-sm muted">No student is linked to this account.</p>
            : (
              <>
                {role === "parent" && (
                  <label className="card block space-y-2 p-4 text-sm font-semibold">
                    <span>Select child</span>
                    <select value={selectedId} className="field max-w-xl" onChange={(event) => {
                      const id = event.target.value;
                      if (!students.some((item) => item.id === id)) return;
                      setSelectedId(id);
                      rememberFamilyChild(userId, id);
                    }}>
                      {students.map((item) => <option key={item.id} value={item.id}>{studentName(item)} · {item.admission_no}</option>)}
                    </select>
                  </label>
                )}
                <ReceiptHistory key={student.id} client={client} student={student} />
              </>
            )}
    </div>
  );
}

function ReceiptHistory({ client, student }: { client: ReturnType<typeof createClient>; student: FamilyStudent }) {
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ page: number; attempt: number; rows: FamilyFeeReceipt[]; count: number; error: boolean }>();
  const view = result?.page === page && result.attempt === attempt ? result : undefined;

  useEffect(() => {
    let active = true;
    const offset = page * pageSize;
    void listFamilyFeeReceipts(client, student.id, pageSize, offset)
      .then(({ rows, count }) => {
        if (active) setResult({ page, attempt, rows, count, error: false });
      }, () => {
        if (active) setResult({ page, attempt, rows: [], count: 0, error: true });
      });
    return () => { active = false; };
  }, [attempt, client, page, student]);

  return (
    <section className="card overflow-hidden" aria-busy={!view}>
      <header className="border-b border-[var(--border)] p-4">
        <h2 className="font-bold">Receipt history</h2>
        <p className="mt-1 text-sm muted">{studentName(student)} · {student.admission_no}</p>
      </header>
      {!view ? <LoadingState variant="table" className="p-4 text-sm muted">Loading receipts…</LoadingState>
        : view.error ? (
          <div className="space-y-3 p-4">
            <p role="alert" className="text-sm text-red-600">Receipts could not be loaded.</p>
            <button type="button" className={button} onClick={() => setAttempt((count) => count + 1)}>Retry receipts</button>
          </div>
        ) : !view.rows.length ? <p className="p-4 text-sm muted">No receipts on this page.</p> : (
          <ul aria-label="Receipt history" className="divide-y divide-[var(--border)]">
            {view.rows.map((row) => (
              <li key={row.id} className="px-4 py-4">
                <dl className="grid grid-cols-3 items-start gap-3 text-sm sm:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr] sm:gap-4">
                  <div className="col-span-3 min-w-0 sm:col-span-1">
                    <dt className="mb-1 text-xs muted">Receipt number</dt>
                    <dd className="font-mono text-xs font-semibold [overflow-wrap:anywhere]">{row.receipt_no}</dd>
                  </div>
                  <div>
                    <dt className="mb-1 text-xs muted">Paid date</dt>
                    <dd>{row.paid_at ? paidDate.format(new Date(row.paid_at)) : "—"}</dd>
                  </div>
                  <div>
                    <dt className="mb-1 text-xs muted">Method</dt>
                    <dd className="capitalize">{row.payment_method === "upi" ? "UPI" : row.payment_method?.replaceAll("_", " ") ?? "—"}</dd>
                  </div>
                  <div className="text-right">
                    <dt className="mb-1 text-xs muted">Receipt amount</dt>
                    <dd className="font-semibold tabular-nums">{formatFeeMoney(row.amount)}</dd>
                  </div>
                </dl>
                {row.status === "reversed" && <div className="mt-3 space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                  <p className="font-semibold">Payment entry reversed{row.reversed_at ? ` · ${paidDate.format(new Date(row.reversed_at))} IST` : ""}</p>
                  <p className="muted">The original receipt is retained. Effective recorded amount: {row.net_amount === null ? "Under review" : formatFeeMoney(row.net_amount)}.</p>
                  {row.reversal_reference && <p className="break-all text-xs muted">Correction reference · {row.reversal_reference}</p>}
                  <p className="text-xs muted">This is a correction of the school’s payment record. Refunds are handled separately by the school.</p>
                </div>}
              </li>
            ))}
          </ul>
        )}
      {view && !view.error && (page > 0 || view.count > pageSize) && (
        <footer className="flex justify-end gap-2 border-t border-[var(--border)] p-4">
          <button type="button" className={button} disabled={!page} onClick={() => setPage((value) => value - 1)}>Previous</button>
          <button type="button" className={button} disabled={(page + 1) * pageSize >= view.count} onClick={() => setPage((value) => value + 1)}>Next</button>
        </footer>
      )}
    </section>
  );
}
