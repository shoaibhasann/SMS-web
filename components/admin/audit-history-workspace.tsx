"use client";

import { ChevronLeft, ChevronRight, Filter, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { LoadingState } from "@/components/ui/skeleton";
import { auditModules, auditPageSize, defaultAuditFilters, listSchoolAuditEvents, validateAuditFilters,
  type AuditCursor, type AuditModule, type AuditPage } from "@/lib/admin/audit-history";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { createClient } from "@/lib/supabase/client";

type Client = ReturnType<typeof createClient>;
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
type Result<T> = { data: T } | { error: string };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold transition hover:bg-[var(--surface-2)] disabled:opacity-50";
const label = "block min-w-0 space-y-2 text-sm font-semibold";
const dateLabel = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
});
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function AuditHistoryWorkspace({ userId }: { userId: string }) {
  return <AuditAccess key={userId} userId={userId} />;
}

function AuditAccess({ userId }: { userId: string }) {
  const [client] = useState(createClient);
  const [access, setAccess] = useState<Result<Access>>();
  const [revision, setRevision] = useState(0);
  const [school, setSchool] = useState("");
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
    loadSchoolManagementAccess(client, "audit history", ["school_admin", "principal"]).then((data) => {
      if (!active) return;
      if (data.userId !== userId) setSessionChanged(true);
      else setAccess({ data });
    }, (error: unknown) => {
      if (active) setAccess({ error: message(error, "School access could not be loaded.") });
    });
    return () => { active = false; };
  }, [client, userId, sessionChanged, revision]);

  const schools = access && "data" in access ? access.data.schools : [];
  const schoolId = schools.some(({ id }) => id === school) ? school : schools.length === 1 ? schools[0].id : "";

  return <div className="space-y-5">
    <header className="flex flex-wrap items-center gap-3">
      <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"><ShieldCheck size={21} /></span>
      <div><p className="text-xs font-semibold uppercase tracking-wider muted">School administration</p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">Audit Logs</h1></div>
      <span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-semibold muted sm:ml-auto">Read-only history</span>
    </header>
    <p className="max-w-3xl text-sm leading-6 muted">Review recorded school actions and decisions. Times and date filters use IST. Records cannot be added, edited or deleted here.</p>
    {sessionChanged ? <p role="alert" className="card p-4 text-sm">Your account changed. Reopen this page to check audit access.</p>
      : !access ? <LoadingState variant="form">Checking school audit access…</LoadingState>
      : "error" in access ? <section className="card space-y-3 p-4"><p role="alert" className="text-sm">{access.error}</p>
        <button type="button" className={button} onClick={() => { setAccess(undefined); setRevision((value) => value + 1); }}>Reload school access</button></section>
      : <>
        <label className={`${label} card p-4`}><span>School</span>
          <select aria-label="School" className="field max-w-xl" value={schoolId} disabled={schools.length === 1} onChange={(event) => setSchool(event.target.value)}>
            <option value="">Select school</option>{schools.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {schoolId ? <SchoolAuditHistory key={schoolId} client={client} schoolId={schoolId} />
          : <p className="card p-4 text-sm muted">Select a school to review its recorded history.</p>}
      </>}
  </div>;
}

function SchoolAuditHistory({ client, schoolId }: { client: Client; schoolId: string }) {
  const [draft, setDraft] = useState(defaultAuditFilters);
  const [query, setQuery] = useState(() => ({ filters: defaultAuditFilters(), cursors: [null] as (AuditCursor | null)[], revision: 0 }));
  const [response, setResponse] = useState<{ query: typeof query; result: Result<AuditPage> }>();
  const [invalid, setInvalid] = useState<string | null>(null);
  const headingId = useId();
  const page = query.cursors.length;
  const result = response?.query === query ? response.result : undefined;
  const data = result && "data" in result ? result.data : undefined;

  useEffect(() => {
    const controller = new AbortController();
    listSchoolAuditEvents(client, schoolId, query.filters, query.cursors.at(-1) ?? null, controller.signal).then((data) => {
      if (!controller.signal.aborted) setResponse({ query, result: { data } });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setResponse({ query, result: { error: message(error, "Audit history could not be loaded.") } });
    });
    return () => controller.abort();
  }, [client, schoolId, query]);

  useEffect(() => {
    const refresh = () => setQuery((current) => ({ ...current, cursors: [null], revision: current.revision + 1 }));
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, []);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validateAuditFilters(draft);
    setInvalid(error);
    if (!error) setQuery((current) => ({ filters: { ...draft }, cursors: [null], revision: current.revision + 1 }));
  }

  return <>
    <form aria-label="Audit history filters" onSubmit={apply} className="card space-y-4 p-4 sm:p-5">
      <div className="flex items-center gap-2"><Filter size={17} aria-hidden="true" /><h2 className="font-semibold">Filter history</h2></div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.3fr_auto] xl:items-end">
        <label className={label}><span>From (IST)</span><input className="field" type="date" required value={draft.from}
          onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} /></label>
        <label className={label}><span>To (IST)</span><input className="field" type="date" required value={draft.to}
          onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} /></label>
        <label className={label}><span>Module</span><select aria-label="Module" className="field" value={draft.module ?? ""}
          onChange={(event) => setDraft((current) => ({ ...current, module: (event.target.value || null) as AuditModule | null }))}>
          <option value="">All covered modules</option>{auditModules.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <button type="submit" className={`${button} bg-blue-700 text-white hover:bg-blue-800`}>Apply filters</button>
      </div>
      <p className="text-xs leading-5 muted">Choose up to 366 days. Filters take effect when you select Apply filters.</p>
      {invalid && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{invalid}</p>}
    </form>
    <section className="card overflow-hidden" aria-labelledby={headingId} aria-busy={!result}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4 sm:px-5">
        <div><h2 id={headingId} className="font-semibold">Recorded activity</h2>
          <p className="mt-1 text-xs leading-5 muted">{query.filters.from} to {query.filters.to} · {auditModules.find(({ key }) => key === query.filters.module)?.label ?? "All covered modules"} · newest first</p></div>
        <button type="button" className={button} onClick={() => setQuery((current) => ({ ...current, cursors: [null], revision: current.revision + 1 }))}>
          <RefreshCw size={16} aria-hidden="true" /> Refresh history</button>
      </header>
      {!result ? <LoadingState variant="table" className="p-4 sm:p-5">Loading audit history…</LoadingState>
        : "error" in result ? <p role="alert" className="p-4 text-sm text-red-700 dark:text-red-300 sm:p-5">{result.error}</p>
        : !result.data.events.length ? <p className="p-4 text-sm muted sm:p-5">No recorded activity matches these filters.</p>
        : <ol aria-label="Audit events" className="divide-y divide-[var(--border)]">
          {result.data.events.map((event) => <li key={event.id} className="grid gap-3 p-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-5 sm:p-5">
            <div><time dateTime={event.occurred_at} className="block text-xs leading-5 muted">{dateLabel.format(new Date(event.occurred_at))} IST</time>
              <span className="mt-2 inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">{auditModules.find(({ key }) => key === event.module)?.label}</span></div>
            <div className="min-w-0"><h3 className="break-words text-sm font-semibold">{event.action}</h3>
              <p className="mt-1 break-words text-sm">{event.record_label}</p>
              <p className="mt-2 break-words text-xs muted">Recorded by {event.actor_name ?? "School account (name unavailable)"}</p>
              <p className="mt-1 break-all text-xs muted">Reference: {event.id}</p></div>
          </li>)}
        </ol>}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] p-4 sm:px-5">
        <p role="status" className="text-xs muted">Page {page} · up to {auditPageSize} events per page</p>
        <nav aria-label="Audit history pages" className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={!result || page === 1} onClick={() => setQuery((current) => ({ ...current, cursors: current.cursors.slice(0, -1) }))}>
            <ChevronLeft size={16} aria-hidden="true" /> Previous</button>
          <button type="button" className={button} disabled={!data?.next_cursor} onClick={() => {
            if (data?.next_cursor) setQuery((current) => ({ ...current, cursors: [...current.cursors, data.next_cursor] }));
          }}>Next <ChevronRight size={16} aria-hidden="true" /></button>
        </nav>
      </footer>
    </section>
    <aside className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-xs leading-6 muted">
      <h2 className="font-semibold text-[var(--text)]">What this history covers</h2>
      <p>Recorded guardian access/contact changes, attendance corrections and cutoff changes, roster placement/withdrawal/session activation, student leave decisions, result publication reviews and timetable changes. This is a view of saved evidence; other ERP actions and older unrecorded changes may not appear. Private reasons, contact values and raw record payloads are excluded.</p>
    </aside>
  </>;
}
