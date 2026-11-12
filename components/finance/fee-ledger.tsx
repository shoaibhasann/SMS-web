"use client";

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowLeft, ArrowRight, RefreshCw, Scale } from "lucide-react";
import { formatFeeMoney, getOfficeFeeLedger, type FeeLedger } from "@/lib/finance/fee-batches";
import { LoadingState } from "@/components/ui/skeleton";
import { formatSchoolDay, statusTone } from "@/lib/finance/fee-print";

type Props = { client: SupabaseClient; schoolId: string; academicYearId: string };
const pageSize = 25;
const action = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-50";
const money = (value: string | null) => value === null ? "Needs review" : formatFeeMoney(value);

export function FeeLedgerWorkspace({ client, schoolId, academicYearId }: Props) {
  const [scope, setScope] = useState<"current" | "all">(academicYearId ? "current" : "all");
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [viewer, setViewer] = useState<string | null>(null);
  const [authError, setAuthError] = useState("");
  const [result, setResult] = useState<{ key: string; ledger?: FeeLedger; error?: string }>();
  const viewerRef = useRef<string | null>(null);
  const year = scope === "current" ? academicYearId : null;
  const key = JSON.stringify([schoolId, year, viewer, page, refresh]);
  const current = result?.key === key ? result : undefined;

  useEffect(() => {
    let active = true;
    let authGeneration = 0;
    const applyViewer = (id: string) => {
      if (!active) return;
      viewerRef.current = id;
      setViewer(id);
      setAuthError(id ? "" : "Sign in with a school finance account to read the ledger.");
    };
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      authGeneration += 1;
      applyViewer(session?.user?.id ?? "");
    });
    const generation = authGeneration;
    void client.auth.getUser().then(({ data, error }) => {
      if (active && generation === authGeneration) applyViewer(error ? "" : data.user?.id ?? "");
    }, () => { if (active && generation === authGeneration) applyViewer(""); });
    return () => { active = false; subscription.unsubscribe(); };
  }, [client]);

  useEffect(() => {
    if (!viewer || !schoolId || (scope === "current" && !academicYearId)) return;
    let active = true;
    const requestedBy = viewer;
    void getOfficeFeeLedger(client, schoolId, year, null, pageSize, page * pageSize).then(
      (ledger) => {
        if (active && viewerRef.current === requestedBy) setResult({ key, ledger });
      },
      () => {
        if (active && viewerRef.current === requestedBy) setResult({ key, error: "The fee ledger could not be loaded. Refresh to check your access and try again." });
      },
    );
    return () => { active = false; };
  }, [client, schoolId, academicYearId, scope, year, viewer, page, key]);

  const ledger = viewer ? current?.ledger : undefined;
  const summary = ledger?.summary;
  const invalid = Boolean(summary?.invalid_count);
  const total = summary?.demand_count ?? 0;

  return <section aria-labelledby="fee-ledger-title" className="card overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-5 sm:p-6">
      <div>
        <p className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-blue-600 dark:text-blue-300"><Scale size={15} aria-hidden="true" /> Fee reconciliation</p>
        <h2 id="fee-ledger-title" className="text-xl font-bold">Demand and balance ledger</h2>
        <p className="mt-2 max-w-2xl text-sm muted">Balances follow the charge’s academic session and approved adjustments. Applied payments exclude reversed entries and include all collection dates. Opening balances are outstanding debt and do not create a cash receipt.</p>
      </div>
      <button type="button" className={action} onClick={() => setRefresh((value) => value + 1)} disabled={!viewer}><RefreshCw size={15} aria-hidden="true" /> Refresh ledger</button>
    </div>
    <div className="space-y-5 p-5 sm:p-6">
      <label className="block max-w-sm space-y-2 text-sm font-semibold"><span>Reporting session</span>
        <select className="field" value={scope} onChange={(event) => { setPage(0); setScope(event.target.value as "current" | "all"); }}>
          <option value="current" disabled={!academicYearId}>Current academic session</option>
          <option value="all">All retained sessions</option>
        </select>
      </label>
      {authError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{authError}</p>
        : current?.error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{current.error}</p>
          : !ledger ? <LoadingState variant="table" className="text-sm muted">Loading the fee ledger…</LoadingState> : <>
            {invalid && <p role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">{summary!.invalid_count} record{summary!.invalid_count === 1 ? " needs" : "s need"} review for missing session mapping or inconsistent amounts. Reconciliation totals are withheld until the office resolves these records.</p>}
            {!invalid && summary && <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[["Net demands", summary.net_amount], ["Payments applied", summary.paid_amount], ["Outstanding", summary.balance], ["Opening debt included", summary.opening_amount]].map(([label, value]) => <div key={label} className="min-w-0 rounded-xl bg-[var(--surface-2)] p-4">
                <dt className="text-xs font-medium muted">{label}</dt><dd className="mt-2 break-words text-lg font-bold tabular-nums">{money(value)}</dd>
              </div>)}
            </dl>}
            <p className="text-xs muted">Totals cover all {total} demand{total === 1 ? "" : "s"} in this reporting scope. {ledger.rows.length > 0 ? `Showing ${page * pageSize + 1}–${page * pageSize + ledger.rows.length}.` : "No demands on this page."}</p>
            {ledger.rows.length > 0 ? <ul aria-label="Fee demand ledger" className="space-y-3">
              {ledger.rows.map((row) => <li key={row.demand_id} className="space-y-3 rounded-xl border border-[var(--border)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0"><h3 className="break-words font-semibold">{row.student_name} · {row.admission_no}</h3>
                    <p className="mt-1 break-words text-sm muted">{row.fee_name}{row.kind === "opening" ? " · Brought forward" : row.billing_period ? ` · ${row.billing_period}` : ""}</p>
                    <p className="mt-1 text-xs muted">{row.academic_year_name || "Unassigned academic session"}{row.due_date ? ` · Due ${formatSchoolDay(row.due_date)}` : ""}</p>
                    {row.kind === "opening" && row.source_reference && <p className="mt-1 break-words text-xs muted">Source · {row.source_reference}{row.as_of_date ? ` · As of ${row.as_of_date}` : ""}</p>}
                    {row.adjustment_amount && row.adjustment_amount !== "0.00" && row.base_net_amount && <p className="mt-2 break-words text-xs muted">Original net {formatFeeMoney(row.base_net_amount)} · Approved adjustments {formatFeeMoney(row.adjustment_amount)}</p>}
                    {row.reversed_amount && row.reversed_amount !== "0.00" && <p className="mt-1 break-words text-xs muted">Reversed payments {formatFeeMoney(row.reversed_amount)}</p>}
                    {row.advance_applied_amount && row.advance_applied_amount !== "0.00" && <p className="mt-1 break-words text-xs muted">Included advance applied {formatFeeMoney(row.advance_applied_amount)} · No new cash collection</p>}
                  </div>
                  <span className={statusTone(row.status)}>{row.status.replaceAll("_", " ")}</span>
                </div>
                <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
                  {[["Net demand", row.net_amount], ["Applied", row.paid_amount], ["Balance", row.balance]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs muted">{label}</dt><dd className="mt-1 break-words text-sm font-semibold tabular-nums">{value === null ? "—" : formatFeeMoney(value)}</dd></div>)}
                </dl>
              </li>)}
            </ul> : <p className="rounded-xl bg-[var(--surface-2)] p-4 text-sm muted">No fee demands found in this reporting scope.</p>}
            {(page > 0 || total > pageSize) && <div className="flex flex-wrap gap-2">
              <button type="button" className={action} disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ArrowLeft size={15} aria-hidden="true" /> Previous</button>
              <button type="button" className={action} disabled={(page + 1) * pageSize >= total} onClick={() => setPage((value) => value + 1)}>Next <ArrowRight size={15} aria-hidden="true" /></button>
            </div>}
          </>}
    </div>
  </section>;
}
