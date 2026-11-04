"use client";

import Link from "next/link";
import { BellRing, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { guardianNotificationsPath } from "@/lib/attendance/family";
import { createClient } from "@/lib/supabase/client";

type AttendanceAlert = { id: string; student_name: string; attendance_date: string };
type AlertResult = { alerts: AttendanceAlert[] } | { error: string };

const loadError = "Attendance alerts could not be loaded. Refresh to try again.";
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
});

function formatAttendanceDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

export function GuardianAttendanceAlerts({ userId, summary = false }: { userId: string; summary?: boolean }) {
  const [client] = useState(createClient);
  const [response, setResponse] = useState<{ version: number; result: AlertResult }>();
  const [version, setVersion] = useState(0);
  const [sessionChanged, setSessionChanged] = useState(false);
  const headingId = useId();
  const result = response?.version === version ? response.result : undefined;

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);

  const refresh = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    if (sessionChanged) return;
    const controller = new AbortController();
    async function load() {
      try {
        const { data, error } = await client.rpc("list_guardian_absence_alerts")
          .abortSignal(controller.signal).returns<AttendanceAlert[]>();
        if (error || !Array.isArray(data) || data.some((alert) => !alert
          || typeof alert.id !== "string" || typeof alert.student_name !== "string"
          || typeof alert.attendance_date !== "string")) {
          throw error ?? new Error(loadError);
        }
        if (!controller.signal.aborted) setResponse({ version, result: { alerts: data } });
      } catch {
        if (!controller.signal.aborted) setResponse({ version, result: { error: loadError } });
      }
    }
    void load();
    return () => controller.abort();
  }, [client, sessionChanged, version]);

  useEffect(() => {
    if (sessionChanged) return;
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refresh();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refresh, sessionChanged]);

  return (
    <section className="card overflow-hidden" aria-labelledby={headingId} aria-busy={!sessionChanged && !result}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <BellRing size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 id={headingId} className="font-bold">Attendance alerts</h2>
            <p className="mt-1 text-sm muted">Absences recorded by the school for your linked children.</p>
          </div>
        </div>
        <button type="button" aria-label="Refresh attendance alerts" disabled={!result || sessionChanged} onClick={refresh}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold disabled:opacity-50">
          <RefreshCw size={15} aria-hidden="true" /> Refresh
        </button>
      </header>
      {sessionChanged ? <p role="alert" className="p-4 text-sm muted">Your sign-in changed. Reopen this page to check attendance alerts.</p>
        : !result ? <p role="status" className="p-4 text-sm muted">Loading attendance alerts…</p>
          : "error" in result ? <p role="alert" className="p-4 text-sm text-red-700 dark:text-red-300">{result.error}</p>
            : result.alerts.length === 0 ? <p className="p-4 text-sm muted">No attendance alerts for your linked children.</p>
              : <ul className="divide-y divide-[var(--border)]">
                {(summary ? result.alerts.slice(0, 5) : result.alerts).map((alert) => (
                  <li key={alert.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <p className="min-w-0 break-words text-sm"><strong>{alert.student_name}</strong> was marked absent.</p>
                    <time className="shrink-0 text-sm muted" dateTime={alert.attendance_date}>
                      {formatAttendanceDate(alert.attendance_date)}
                    </time>
                  </li>
                ))}
              </ul>}
      {summary && (
        <footer className="border-t border-[var(--border)] px-4 py-2">
          <Link href={guardianNotificationsPath} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 hover:underline dark:text-blue-300">
            View all alerts
          </Link>
        </footer>
      )}
    </section>
  );
}
