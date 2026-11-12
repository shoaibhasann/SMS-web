"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { CalendarDays, CircleCheck, LockKeyhole, RefreshCw } from "lucide-react";
import { schoolDate } from "@/lib/attendance/types";
import type { createClient } from "@/lib/supabase/client";
import { feeMoney, formatFeeMoney } from "@/lib/finance/fee-batches";
import { LoadingState } from "@/components/ui/skeleton";

type OfficeDay = {
  business_date: string;
  revision: number;
  receipt_count: number;
  recorded_total: number | string;
  recorded_cash: number | string;
  gross_total?: number | string;
  reversed_total?: number | string;
  reversal_count?: number;
  advance_total?: number | string;
  advance_count?: number;
  refunded_total?: number | string;
  refund_count?: number;
  invalid_count: number;
  methods: { method: string; receipt_count: number; total: number | string; reversal_count?: number; gross_total?: number | string; reversed_total?: number | string; advance_total?: number | string; advance_count?: number; refunded_total?: number | string; refund_count?: number }[];
  closed_at: string | null;
  closed_by_name: string | null;
  counted_cash: number | string | null;
  cash_variance: number | string | null;
  variance_note: string | null;
};

type Review = { day: string; refresh: number; snapshot: OfficeDay | null; error: string };

const closedTime = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
});
const methodLabels: Record<string, string> = {
  cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", card: "Card",
  cheque: "Cheque", unclassified: "Unclassified",
};

function cashDifference(counted: string, recorded: string | number) {
  const asPaise = (value: string | number) => {
    const canonical = feeMoney(value), sign = canonical.startsWith("-") ? -BigInt(1) : BigInt(1);
    return BigInt(canonical.replace(/^-/, "").replace(".", "")) * sign;
  };
  const delta = asPaise(counted) - asPaise(recorded), absolute = delta < BigInt(0) ? -delta : delta;
  return `${delta < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}

export function CashierDayClose({ schoolId, client }: { schoolId: string; client: ReturnType<typeof createClient> }) {
  const today = schoolDate();
  const [day, setDay] = useState(today);
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<Review>();
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const activeReview = review?.day === day && review.refresh === refresh ? review : undefined;
  const snapshot = activeReview?.snapshot;

  useEffect(() => {
    if (!day) return;
    let active = true;
    async function load() {
      try {
        const result = await client.rpc("get_office_fee_day", { p_school_id: schoolId, p_day: day });
        if (!active) return;
        if (result.error || !result.data) {
          setReview({ day, refresh, snapshot: null, error: "Could not load this day's receipts. Refresh to try again." });
        } else {
          setReview({ day, refresh, snapshot: result.data as OfficeDay, error: "" });
        }
      } catch {
        if (active) setReview({ day, refresh, snapshot: null, error: "Could not load this day's receipts. Refresh to try again." });
      }
    }
    void load();
    return () => { active = false; };
  }, [client, day, refresh, schoolId]);

  function refreshReview() {
    setConfirming(false);
    setRequiresRefresh(false);
    setError("");
    setRefresh((value) => value + 1);
  }

  const countedCash = /^\d{1,12}(?:\.\d{1,2})?$/.test(counted) ? feeMoney(counted) : null;
  const difference = countedCash !== null && snapshot
    ? cashDifference(countedCash, snapshot.recorded_cash)
    : null;
  const hasVariance = difference !== null && difference !== "0.00";
  const canClose = !requiresRefresh && countedCash !== null && (!hasVariance || Boolean(note.trim()));

  async function closeDay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || snapshot.closed_at || snapshot.invalid_count || countedCash === null
      || !canClose || requiresRefresh || inFlight.current) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await client.rpc("close_office_fee_day", {
        p_school_id: schoolId,
        p_day: snapshot.business_date,
        p_revision: snapshot.revision,
        p_counted_cash: Number(countedCash),
        p_note: note.trim() || null,
      });
      if (["PT409", "40001", "23505"].includes(result.error?.code ?? "")) {
        setConfirming(false);
        setRequiresRefresh(true);
        setError("The day's receipts or close status changed. Your cash count and note are kept. Refresh day and review the latest totals before closing.");
      } else if (result.error?.code === "22023" || result.error?.code === "42501") {
        setError(result.error.message);
      } else if (result.error || !result.data?.closed_at) {
        setError("Could not confirm the close. Retry with the same cash count or refresh to check the saved result.");
      } else {
        setReview({ day, refresh, snapshot: result.data as OfficeDay, error: "" });
        setConfirming(false);
      }
    } catch {
      setError("Could not confirm the close. Retry with the same cash count or refresh to check the saved result.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="cashier-day-title" className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border)] p-5 sm:p-6">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-blue-600 dark:text-blue-300">
            <CalendarDays size={15} aria-hidden="true" /> Daily reconciliation
          </div>
          <h2 id="cashier-day-title" className="text-xl font-bold">Cashier day close</h2>
          <p className="mt-1 max-w-xl text-sm muted">Review fee and advance receipts, recorded offline refunds and entry corrections. Compare net recorded cash with cash on hand. Applying credit and reserving refunds do not move money. Business dates use IST.</p>
        </div>
        {snapshot && (
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${snapshot.closed_at
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "bg-blue-500/10 text-blue-700 dark:text-blue-300"}`}>
            {snapshot.closed_at ? <><LockKeyhole size={13} aria-hidden="true" /> Closed</> : "Open for collection"}
          </span>
        )}
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="w-full max-w-[12rem] space-y-1.5 text-sm font-medium">Business date (IST)
            <input type="date" className="field" required max={today} disabled={saving} value={day} onChange={(event) => {
              setDay(event.target.value);
              setCounted("");
              setNote("");
              refreshReview();
            }} />
          </label>
          <button type="button" disabled={!day || saving} onClick={refreshReview} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2.5 text-sm font-semibold disabled:opacity-50">
            <RefreshCw size={14} aria-hidden="true" /> Refresh day
          </button>
        </div>

        {(activeReview?.error || error) && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{activeReview?.error || error}</p>}
        {!day && <p className="text-sm muted">Choose a business date to review.</p>}
        {day && !activeReview && <LoadingState variant="table" className="text-sm muted">Loading the day’s receipts…</LoadingState>}

        {snapshot && <>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Gross money received", formatFeeMoney(snapshot.gross_total ?? snapshot.recorded_total)],
              ["Advance receipts included", formatFeeMoney(snapshot.advance_total ?? 0)],
              ["Reversal entries", formatFeeMoney(snapshot.reversed_total ?? 0)],
              ["Offline refunds paid", formatFeeMoney(snapshot.refunded_total ?? 0)],
              ["Net day collections", formatFeeMoney(snapshot.recorded_total)],
              ["Net recorded cash", formatFeeMoney(snapshot.recorded_cash)],
            ].map(([label, value]) => <div key={label} className="rounded-xl bg-[var(--surface-2)] p-4">
              <dt className="text-xs font-medium muted">{label}</dt><dd className="mt-1 text-lg font-bold tabular-nums">{value}</dd>
            </div>)}
          </dl>
          <p className="text-xs muted">{snapshot.receipt_count} paid {snapshot.receipt_count === 1 ? "receipt" : "receipts"} ({snapshot.advance_count ?? 0} advance) · {snapshot.reversal_count ?? 0} {(snapshot.reversal_count ?? 0) === 1 ? "reversal" : "reversals"} · {snapshot.refund_count ?? 0} offline {(snapshot.refund_count ?? 0) === 1 ? "refund" : "refunds"}. Earlier closed days retain their original saved totals.</p>

          {snapshot.methods.length > 0 ? (
            <ul aria-label="Collections by method" className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
              {snapshot.methods.map(({ method, receipt_count, total, reversal_count = 0, reversed_total = 0, advance_count = 0, refund_count = 0, refunded_total = 0 }) => (
                <li key={method} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <span className="font-medium">{methodLabels[method] ?? method.replaceAll("_", " ")}</span>
                  <span className="ml-auto text-xs muted">{receipt_count} {receipt_count === 1 ? "receipt" : "receipts"} ({advance_count} advance) · {reversal_count} {reversal_count === 1 ? "reversal" : "reversals"}{reversal_count > 0 && ` (${formatFeeMoney(reversed_total)})`} · {refund_count} offline {refund_count === 1 ? "refund" : "refunds"}{refund_count > 0 && ` (${formatFeeMoney(refunded_total)})`}</span>
                  <span className="min-w-24 text-right font-semibold tabular-nums">Net {formatFeeMoney(total)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm muted">There are no receipts, offline refunds or reversal entries for this date.</p>}

          {snapshot.closed_at ? (
            <div className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="flex items-start gap-2">
                <CircleCheck size={18} aria-hidden="true" className="mt-0.5 text-emerald-600" />
                <div><h3 className="font-semibold">Close recorded</h3>
                  <p className="text-sm muted">{closedTime.format(new Date(snapshot.closed_at))} IST{snapshot.closed_by_name && ` · ${snapshot.closed_by_name}`}</p>
                </div>
              </div>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="muted">Counted cash</dt><dd className="font-semibold">{formatFeeMoney(snapshot.counted_cash ?? 0)}</dd></div>
                <div><dt className="muted">Cash variance</dt><dd className="font-semibold">{formatFeeMoney(snapshot.cash_variance ?? 0)}{feeMoney(snapshot.cash_variance ?? 0) !== "0.00" && <VarianceCue value={snapshot.cash_variance ?? 0} />}</dd></div>
              </dl>
              {snapshot.variance_note && <p className="break-words text-sm muted">{snapshot.variance_note}</p>}
            </div>
          ) : snapshot.invalid_count > 0 ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">Review invalid payment amounts before closing this date.</p>
          ) : (
            <form className="space-y-3" onSubmit={closeDay}>
              <fieldset disabled={saving || confirming} className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm font-medium">Counted cash
                  <input required type="number" min="0" max="999999999999.99" step="0.01" inputMode="decimal" value={counted} onChange={(event) => setCounted(event.target.value)} className="field" placeholder="0.00" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  {hasVariance ? "Variance note (required)" : "Variance note"}
                  <input required={hasVariance} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} className="field" placeholder="Explain any difference" />
                </label>
              </fieldset>
              {difference !== null && <p className="text-sm muted">Cash variance <strong className="tabular-nums">{formatFeeMoney(difference)}</strong>{hasVariance && <VarianceCue value={difference} />}</p>}
              {confirming && <p role="status" className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                Closing locks receipts, offline payouts and reversal entries for this date. New entries for this date will be refused. Credit applications and refund reservations are not cash movements.
              </p>}
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={saving || !canClose} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
                  <LockKeyhole size={15} aria-hidden="true" /> {saving ? "Closing day…" : confirming ? "Confirm day close" : "Review and close day"}
                </button>
                {confirming && <button type="button" disabled={saving} onClick={() => setConfirming(false)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Edit cash count</button>}
              </div>
            </form>
          )}
        </>}
      </div>
    </section>
  );
}

// Shortage/overage spelled out so the cue is not only the minus sign.
function VarianceCue({ value }: { value: number | string }) {
  const short = String(value).startsWith("-");
  return <span className={short ? "text-danger" : "text-warning"}>{short ? " · cash short" : " · cash over"}</span>;
}
