"use client";

import { CalendarCheck, Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";
import { loadOfficeAttendanceContext, loadOfficeAttendanceReport, officeAttendanceUuid, OfficeAttendanceReportError, type OfficeAttendanceContext, type OfficeAttendancePeriod, type OfficeAttendanceReport, type OfficeAttendanceYear } from "@/lib/attendance/office-reports";
import { downloadOfficeAttendanceReportPdf, verifyOfficeAttendanceContext } from "@/lib/attendance/office-report-export";
import { validCalendarDate } from "@/lib/attendance/calendar";

type Props = { userId: string; role: "admin" | "principal" };
type Filters = { yearId: string; month: string | null; classId: string | null; sectionId: string | null };
const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const dateLabel = (value: string) => dateFormat.format(new Date(`${value}T00:00:00Z`));
function months(year: OfficeAttendanceYear | undefined, today: string | undefined) {
  if (!year || !today) return [];
  const last = (year.end_date < today ? year.end_date : today).slice(0, 7), result: string[] = [];
  const date = new Date(`${year.start_date.slice(0, 7)}-01T00:00:00Z`);
  for (let index = 0; index < 13 && date.toISOString().slice(0, 7) <= last; index++) { result.push(date.toISOString().slice(0, 10)); date.setUTCMonth(date.getUTCMonth() + 1); }
  return result;
}
const states = { complete: "Complete register", enrollment_unverified: "Enrollment needs review", inconsistent: "Records need review", calendar_unconfigured: "Calendar setup needed", attendance_incomplete: "Awaiting attendance", no_working_days: "No working pupil-days", not_started: "No elapsed school days", no_pupils: "No enrolled pupils" };
function explanation(period: OfficeAttendancePeriod) {
  if (period.state === "enrollment_unverified") return `${number.format(period.unverified_pupils)} pupil enrollment or historical placement needs review. The official rate is withheld because its denominator is not verified.`;
  if (period.state === "inconsistent") return `${number.format(period.invalid_days)} working pupil-day records need school review. The official rate is withheld.`;
  if (period.state === "calendar_unconfigured") return `${number.format(period.unconfigured_days)} pupil-days have no verified school calendar. The official rate is withheld.`;
  if (period.state === "attendance_incomplete") return `${number.format(period.unmarked_days)} working pupil-days are unmarked. They are not assumed Absent; the official rate is withheld.`;
  if (period.state === "no_working_days") return "This scope has verified enrolled days but no school working pupil-days. A percentage does not apply.";
  if (period.state === "not_started") return "No verified elapsed enrollment days fall in this scope and reporting period.";
  if (period.state === "no_pupils") return "No enrolled pupils are available in the selected scope.";
  return "Weighted earned pupil-days divided by eligible working pupil-days; individual percentages are not averaged.";
}
function PeriodCard({ title, period }: { title: string; period: OfficeAttendancePeriod }) {
  return <article aria-label={title} className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-sm font-semibold">{title}</h2>{period.from && period.to && <p className="mt-1 text-xs leading-5 muted">{dateLabel(period.from)} – {dateLabel(period.to)}</p>}</div><span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] font-semibold">{states[period.state]}</span></header>
    <div><p className="text-3xl font-bold tabular-nums tracking-tight sm:text-4xl">{period.percentage === null ? "—" : `${number.format(period.percentage)}%`}</p><p className="mt-2 text-xs leading-5 muted">{explanation(period)}</p></div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">{[["Working pupil-days", period.working_days], ["Closed pupil-days excluded", period.closed_days], ["Earned pupil-days", period.earned_days], ["Unmarked working pupil-days", period.unmarked_days], ["Pupils in period", period.pupil_count], ["Pupils requiring review", period.incomplete_pupils]].map(([label, value]) => <div className="min-w-0" key={label}><dt className="leading-5 muted">{label}</dt><dd className="mt-1 text-base font-semibold tabular-nums">{number.format(Number(value))}</dd></div>)}</dl>
    <details className="border-t border-[var(--border)] pt-3"><summary className="min-h-8 cursor-pointer text-xs font-semibold text-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2">Calculation details</summary><dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">{[["Present pupil-days", period.present_days], ["Late pupil-days", period.late_days], ["Half Day pupil-days", period.half_days], ["Leave pupil-days", period.leave_days], ["Absent pupil-days", period.absent_days], ["Calendar unconfigured", period.unconfigured_days], ["Records to review", period.invalid_days], ["Verified pupil records", period.complete_pupils], ["Unverified pupils", period.unverified_pupils]].map(([label, value]) => <div className="flex justify-between gap-2" key={label}><dt className="muted">{label}</dt><dd className="font-semibold tabular-nums">{number.format(Number(value))}</dd></div>)}</dl></details>
  </article>;
}
function preference(userId: string, role: Props["role"], context: OfficeAttendanceContext): Filters {
  // The whole-school report is a per-pupil, per-day pass that grows through the year: open on the first class, and
  // keep the whole school one choice away.
  const defaults: Filters = { yearId: context.years.find(year => year.id === context.current_year_id)?.id ?? "", month: null, classId: context.classes[0]?.id ?? null, sectionId: null };
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(`erp:office-attendance:${userId}:${role}:${context.school_id}`) ?? "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaults;
    const row = saved as Record<string, unknown>;
    if (!officeAttendanceUuid(row.yearId) || !(row.month === null || validCalendarDate(row.month) && row.month.endsWith("-01"))
      || !(row.classId === null || officeAttendanceUuid(row.classId)) || !(row.sectionId === null || officeAttendanceUuid(row.sectionId) && row.classId !== null)) return defaults;
    const chosen = context.years.find(option => option.id === row.yearId);
    if (!chosen || row.month !== null && !months(chosen, context.server_today).includes(String(row.month))
      || row.classId !== null && !context.classes.some(option => option.id === row.classId)
      || row.sectionId !== null && !context.sections.some(option => option.id === row.sectionId && option.class_id === row.classId)) {
      sessionStorage.removeItem(`erp:office-attendance:${userId}:${role}:${context.school_id}`); return defaults;
    }
    return row as Filters;
  } catch { return defaults; }
}
export function OfficialAttendanceReports({ userId, role }: Props) {
  const [client] = useState(createClient);
  return <OwnOfficialAttendanceReports key={`${userId}:${role}`} client={client} userId={userId} role={role} />;
}
function OwnOfficialAttendanceReports({ client, userId, role }: Props & { client: ReturnType<typeof createClient> }) {
  const [revision, setRevision] = useState(0), [sessionChanged, setSessionChanged] = useState(false);
  const [catalog, setCatalog] = useState<{ revision: number; data?: OfficeAttendanceContext; error?: string }>();
  const [filters, setFilters] = useState<Filters>({ yearId: "", month: null, classId: null, sectionId: null });
  const [loaded, setLoaded] = useState<{ key: string; data?: OfficeAttendanceReport; error?: string }>();
  const [pdf, setPdf] = useState<{ key: string; busy?: boolean; saved?: boolean; error?: string }>();
  const contextRead = useRef<AbortController | null>(null), reportRead = useRef<AbortController | null>(null), pdfRead = useRef<AbortController | null>(null), restored = useRef(false), loadedAt = useRef(0);
  const context = catalog?.revision === revision ? catalog.data : undefined, currentCatalog = catalog?.revision === revision ? catalog : undefined;
  const key = `${revision}:${filters.yearId}:${filters.month ?? "default"}:${filters.classId ?? "all"}:${filters.sectionId ?? "all"}`;
  const current = loaded?.key === key ? loaded : undefined, report = context ? current?.data : undefined, currentPdf = pdf?.key === key ? pdf : undefined;
  const year = context?.years.find(option => option.id === filters.yearId), classValid = filters.classId === null || context?.classes.some(option => option.id === filters.classId), sectionValid = filters.sectionId === null || context?.sections.some(option => option.id === filters.sectionId && option.class_id === filters.classId);
  const reportingMonths = months(year, context?.server_today), monthValid = filters.month === null || reportingMonths.includes(filters.month);
  function cancel() { contextRead.current?.abort(); reportRead.current?.abort(); pdfRead.current?.abort(); }
  function refresh() { cancel(); setRevision(value => value + 1); }
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { contextRead.current?.abort(); reportRead.current?.abort(); pdfRead.current?.abort(); setSessionChanged(true); setCatalog(undefined); setLoaded(undefined); setPdf(undefined); }
    });
    return () => { contextRead.current?.abort(); reportRead.current?.abort(); pdfRead.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId]);
  useEffect(() => {
    // Avoid rerunning the school-wide report on every alt-tab; Refresh still reloads on demand.
    const update = () => { if (document.visibilityState === "visible" && Date.now() - loadedAt.current >= 5 * 60_000) { contextRead.current?.abort(); reportRead.current?.abort(); pdfRead.current?.abort(); setRevision(value => value + 1); } };
    window.addEventListener("focus", update); document.addEventListener("visibilitychange", update);
    return () => { window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  useEffect(() => {
    if (sessionChanged) return;
    const controller = new AbortController(); contextRead.current = controller;
    loadOfficeAttendanceContext(client, userId, null, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (!restored.current) { restored.current = true; setFilters(preference(userId, role, data)); }
      setCatalog({ revision, data });
    }, (failure: unknown) => { if (!controller.signal.aborted) { setCatalog({ revision, error: failure instanceof OfficeAttendanceReportError ? failure.message : "School report setup could not be loaded. Retry access check." }); setLoaded(undefined); } });
    return () => { controller.abort(); if (contextRead.current === controller) contextRead.current = null; };
  }, [client, userId, role, revision, sessionChanged]);
  useEffect(() => {
    if (!context || !year || !classValid || !sectionValid || !monthValid || sessionChanged) return;
    const controller = new AbortController(); reportRead.current = controller;
    loadOfficeAttendanceReport(client, userId, { schoolId: context.school_id, academicYearId: year.id, month: filters.month, classId: filters.classId, sectionId: filters.sectionId }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      verifyOfficeAttendanceContext(data, context); loadedAt.current = Date.now(); setLoaded({ key, data });
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof OfficeAttendanceReportError && failure.code === "access") { contextRead.current?.abort(); setCatalog({ revision, error: failure.message }); }
      setLoaded({ key, error: failure instanceof OfficeAttendanceReportError ? failure.message : "The school report could not be loaded. Refresh to try again." });
    });
    return () => { controller.abort(); if (reportRead.current === controller) reportRead.current = null; };
  }, [client, userId, context, year, classValid, sectionValid, monthValid, filters.month, filters.classId, filters.sectionId, key, revision, sessionChanged]);
  function choose(next: Filters) {
    reportRead.current?.abort(); pdfRead.current?.abort(); setFilters(next);
    if (context) { try { sessionStorage.setItem(`erp:office-attendance:${userId}:${role}:${context.school_id}`, JSON.stringify(next)); } catch { /* Filter persistence is optional. */ } }
  }
  async function exportPdf() {
    if (!report || sessionChanged || pdfRead.current && !pdfRead.current.signal.aborted) return;
    const controller = new AbortController(); pdfRead.current = controller; setPdf({ key, busy: true });
    try { await downloadOfficeAttendanceReportPdf(client, userId, report, controller.signal); if (!controller.signal.aborted) setPdf({ key, saved: true }); }
    catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof OfficeAttendanceReportError && failure.code === "access") { contextRead.current?.abort(); reportRead.current?.abort(); setCatalog({ revision, error: failure.message }); setLoaded(undefined); setPdf(undefined); }
      else setPdf({ key, error: failure instanceof Error ? failure.message : "The PDF could not be downloaded. Refresh the report and try again." });
    } finally { if (pdfRead.current === controller) pdfRead.current = null; }
  }
  const cutoff = report ? report.year.end_date < report.server_today ? report.year.end_date : report.server_today : undefined;
  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-[var(--primary)]">School administration</p><h1 className="mt-1 text-2xl font-black sm:text-3xl">Official attendance reports</h1><p className="mt-2 max-w-3xl text-sm leading-6 muted">Verified class and school attendance, weighted by eligible pupil-days.</p></div><button type="button" className={control} onClick={refresh} disabled={sessionChanged || !currentCatalog} aria-label="Refresh official school attendance"><RefreshCw size={16} aria-hidden="true" />Refresh</button></header>
    {sessionChanged ? <p role="alert" className="card p-4 text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reopen Reports to check school attendance.</p>
      : !currentCatalog ? <LoadingState variant="form">Checking official report access…</LoadingState>
        : !context ? <section className="card space-y-3 p-4"><p role="alert" className="text-sm text-red-700 dark:text-red-300">{currentCatalog.error}</p><button type="button" className={control} onClick={refresh}>Retry access check</button></section>
          : <>
            <section aria-label="Official attendance filters" className="card grid min-w-0 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-5">
              <label className="min-w-0 space-y-2 text-sm font-semibold"><span>School</span><select aria-label="School" className="field" value={context.school_id} disabled>{context.schools.map(school => <option key={school.id} value={school.id}>{school.name}</option>)}</select></label>
              <label className="min-w-0 space-y-2 text-sm font-semibold"><span>Academic year</span><select aria-label="Academic year" className="field" value={filters.yearId} onChange={event => choose({ ...filters, yearId: event.target.value, month: null })}><option value="">Select academic year</option>{filters.yearId && !year && <option value={filters.yearId} disabled>Selected year unavailable</option>}{context.years.map(option => <option key={option.id} value={option.id}>{option.name}{option.is_current ? " · Current" : " · Previous year"}</option>)}</select></label>
              <label className="min-w-0 space-y-2 text-sm font-semibold"><span>Reporting month</span><select aria-label="Reporting month" className="field" value={filters.month ?? report?.month ?? ""} disabled={!year || !reportingMonths.length} onChange={event => choose({ ...filters, month: event.target.value })}>{!report && filters.month === null && <option value="">Current or year-end month</option>}{filters.month && !monthValid && <option value={filters.month} disabled>Selected month unavailable</option>}{reportingMonths.map(value => <option key={value} value={value}>{monthFormat.format(new Date(`${value}T00:00:00Z`))}</option>)}</select></label>
              <label className="min-w-0 space-y-2 text-sm font-semibold"><span>Class</span><select aria-label="Class" className="field" value={filters.classId ?? ""} onChange={event => choose({ ...filters, classId: event.target.value || null, sectionId: null })}><option value="">Whole school</option>{!classValid && <option value={filters.classId!} disabled>Selected class unavailable</option>}{context.classes.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
              <label className="min-w-0 space-y-2 text-sm font-semibold"><span>Section</span><select aria-label="Section" className="field" value={filters.sectionId ?? ""} disabled={!filters.classId || !classValid} onChange={event => choose({ ...filters, sectionId: event.target.value || null })}><option value="">All sections</option>{!sectionValid && <option value={filters.sectionId!} disabled>Selected section unavailable</option>}{context.sections.filter(option => option.class_id === filters.classId).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
            </section>
            {!year || !classValid || !sectionValid || !monthValid ? <p role="status" className="card p-4 text-sm leading-6 muted">Choose an available academic year, month, class and section. Current-year setup may need school review; available previous years can still be selected.</p>
              : !current ? <LoadingState variant="cards">Loading verified school attendance…</LoadingState>
                : current.error ? <p role="alert" className="card p-4 text-sm text-red-700 dark:text-red-300">{current.error}</p>
                  : report && <section aria-label="Official school attendance" className="dashboard-panel min-w-0 space-y-4 p-4 sm:p-5">
                    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-base font-semibold"><CalendarCheck size={18} aria-hidden="true" className="text-[var(--primary)]" />{report.scope.class_name ? `${report.scope.class_name}${report.scope.section_name ? ` · ${report.scope.section_name}` : " · All sections"}` : "Whole school"}</h2><p className="mt-1 text-xs leading-5 muted">{report.year.name} · {number.format(report.pupil_count)} scope pupil candidates · Through {cutoff && dateLabel(cutoff)} (IST)</p></div><button type="button" className={control} disabled={currentPdf?.busy} aria-busy={currentPdf?.busy || undefined} onClick={exportPdf}><Download size={16} aria-hidden="true" />{currentPdf?.busy ? "Preparing PDF…" : "Download PDF"}</button></header>
                    {currentPdf?.error && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">{currentPdf.error}</p>}{currentPdf?.saved && <p role="status" className="text-xs muted">PDF download started for the selected school, class, academic year and month.</p>}
                    <div className="grid gap-3 lg:grid-cols-2"><PeriodCard title="Monthly attendance" period={report.month_summary} /><PeriodCard title="Academic session attendance" period={report.year_summary} /></div>
                    <footer className="border-t border-[var(--border)] pt-3 text-xs leading-5 muted">One pupil attending one working day is one pupil-day. Present/Late = 1, Half Day = 0.5, Leave/Absent = 0. Closed days are excluded for each eligible pupil; historical class/section moves split membership by date. Unknown enrollment, calendar or marks withhold the official rate. Reports reflect current verified records, including approved corrections.</footer>
                  </section>}
          </>}
  </div>;
}
