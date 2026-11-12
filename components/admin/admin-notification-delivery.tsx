"use client";

import Link from "next/link";
import { ArrowUpRight, BellRing, RefreshCw, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadingState } from "@/components/ui/skeleton";
import { boundMfaSession, mfaPath } from "@/lib/auth/staff-mfa";
import { createClient } from "@/lib/supabase/client";

const active = [
  { key: "queued", label: "Queued", detail: "Waiting for a delivery attempt" },
  { key: "leased", label: "In progress", detail: "Reserved for a delivery attempt" },
] as const;
const recent = [
  { key: "accepted", label: "Accepted by Firebase", detail: "Phone receipt is verified separately" },
  { key: "failed", label: "Failed", detail: "Delivery attempt ended in error" },
  { key: "cancelled", label: "Cancelled", detail: "Removed from the delivery queue" },
] as const;
type Counts = Record<(typeof active | typeof recent)[number]["key"], number>;
type Summary = { counts: Counts; configured: boolean | null } | { error: string; setup?: boolean };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";
const loadError = { error: "Mobile push delivery could not be loaded. Refresh to try again." };
const format = new Intl.NumberFormat("en-IN");

export function AdminNotificationDelivery({ userId, schoolId }: { userId: string; schoolId: string }) {
  const [client] = useState(createClient);
  const [summary, setSummary] = useState<Summary>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const show = (result: Summary) => { if (!signal.aborted) setSummary(result); };
    void (async () => {
      try {
        const session = await boundMfaSession(client, userId, signal);
        if (!session) { show({ error: "Sign in again to view mobile push delivery." }); return; }
        const { data, error } = await client.rpc("get_school_push_delivery_summary", { p_school_id: schoolId })
          .setHeader("Authorization", `Bearer ${session.access_token}`).abortSignal(signal);
        if (signal.aborted) return;
        if (error?.code === "42501") {
          const setup = error.message === "Verify your authenticator to view mobile push delivery.";
          show({ error: setup ? error.message : "Your current school assignment does not allow access to mobile push delivery.", setup });
          return;
        }
        const counts = data?.counts as Counts | undefined;
        if (error || !counts || ![...active, ...recent].every(({ key }) => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) {
          show(loadError);
          return;
        }
        let configured: boolean | null = null;
        try {
          const response = await fetch("/api/push/status", { cache: "no-store", signal });
          if (response.ok) {
            const status = await response.json();
            if (status?.nativeAppRequired === true && typeof status.configured === "boolean") configured = status.configured;
          }
        } catch { /* The school totals are available even if readiness could not be checked. */ }
        show({ counts, configured });
      } catch { show(loadError); }
    })();
    return () => controller.abort();
  }, [client, revision, schoolId, userId]);

  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"><BellRing size={21} /></span>
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-[var(--primary)]">School administration</p>
          <h1 className="mt-1 text-2xl font-black sm:text-3xl">Notifications</h1>
          <p className="mt-2 text-sm leading-6 muted">Review mobile push activity for your school.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={!summary} onClick={() => { setSummary(undefined); setRevision((value) => value + 1); }}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
        <Link href="/modules/notices" className={button}>Notices &amp; Circulars <ArrowUpRight size={16} aria-hidden="true" /></Link>
      </div>
    </header>

    {!summary ? <LoadingState variant="cards">Loading mobile push delivery…</LoadingState>
      : "error" in summary ? <section className="card space-y-3 p-5">
        <p role="alert" className="text-sm text-danger">{summary.error}</p>
        {summary.setup && <Link href={`${mfaPath("/modules/notifications")}&setup=1`} className={button}>Set up authenticator</Link>}
      </section> : <section className="card space-y-5 p-5" aria-labelledby="push-delivery-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Smartphone aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-[var(--primary)]" />
            <div>
              <h2 id="push-delivery-heading" className="font-semibold">Mobile push delivery</h2>
              <p className="mt-1 text-sm muted">Each delivery job represents one eligible device.</p>
            </div>
          </div>
          <span role="status" className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold">
            {summary.configured === null ? "Sender status unavailable" : summary.configured ? "Sender configured" : "Sender setup pending"}
          </span>
        </div>
        {summary.configured === false && <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm leading-6 muted">The mobile sender needs setup before queued alerts can be sent. Families can still read alerts in their notification inbox.</p>}
        {[{ label: "Current queue", items: active }, { label: "Outcomes in the last 7 days", items: recent }].map(({ label, items }) => <div key={label}>
          <h3 className="mb-2 text-sm font-semibold">{label}</h3>
          <dl className={`grid gap-3 ${items === active ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
            {items.map(({ key, label: name, detail }) => <div key={key} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
              <dt className="text-sm font-semibold">{name}</dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums">{format.format(summary.counts[key])}</dd>
              <dd className="mt-1 text-xs leading-5 muted">{detail}</dd>
            </div>)}
          </dl>
        </div>)}
        {Object.values(summary.counts).every((count) => count === 0) && <p role="status" className="text-sm muted">There are no current jobs or recent delivery outcomes for this school.</p>}
      </section>}
  </div>;
}
