"use client";

import Link from "next/link";
import { BellRing, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { guardianNotificationsPath } from "@/lib/attendance/family";
import { createClient } from "@/lib/supabase/client";

type AttendanceAlert = { id: string; student_name: string; attendance_date: string; read_at?: string | null };
type AttendanceInbox = { alerts: AttendanceAlert[]; unread_count: number };
type AlertResult = { alerts: AttendanceAlert[]; unreadCount?: number } | { error: string };

const loadError = "Attendance alerts could not be loaded. Refresh to try again.";
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
});

function formatAttendanceDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

function isAttendanceInbox(value: unknown): value is AttendanceInbox {
  return typeof value === "object" && value !== null
    && "alerts" in value && Array.isArray(value.alerts)
    && "unread_count" in value && typeof value.unread_count === "number"
    && Number.isSafeInteger(value.unread_count) && value.unread_count >= 0;
}

export function GuardianAttendanceAlerts({ userId, summary = false }: { userId: string; summary?: boolean }) {
  const [client] = useState(createClient);
  const [response, setResponse] = useState<{ version: number; result: AlertResult }>();
  const [version, setVersion] = useState(0);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [pendingAlert, setPendingAlert] = useState<string>();
  const [markError, setMarkError] = useState<string>();
  const markRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const result = response?.version === version ? response.result : undefined;
  const inboxResult = result && "alerts" in result ? result : undefined;

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        markRequest.current?.abort();
        setSessionChanged(true);
      }
    });
    return () => {
      markRequest.current?.abort();
      subscription.unsubscribe();
    };
  }, [client, userId]);

  const refresh = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    if (sessionChanged) return;
    const controller = new AbortController();
    async function load() {
      try {
        const { data, error } = await client.rpc(summary ? "list_guardian_absence_alerts" : "get_guardian_absence_inbox")
          .abortSignal(controller.signal).returns<unknown>();
        const inbox = !summary && isAttendanceInbox(data) ? data : undefined;
        const alerts = summary ? data : inbox?.alerts;
        if (error || !Array.isArray(alerts) || alerts.some((alert) => !alert
          || typeof alert.id !== "string" || typeof alert.student_name !== "string"
          || typeof alert.attendance_date !== "string"
          || (!summary && alert.read_at !== null && typeof alert.read_at !== "string"))) {
          throw error ?? new Error(loadError);
        }
        if (!controller.signal.aborted) setResponse({ version, result: { alerts, unreadCount: inbox?.unread_count } });
      } catch {
        if (!controller.signal.aborted) setResponse({ version, result: { error: loadError } });
      }
    }
    void load();
    return () => controller.abort();
  }, [client, sessionChanged, summary, version]);

  useEffect(() => {
    if (sessionChanged) return;
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refresh();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refresh, sessionChanged]);

  async function markAsRead(alertId: string, button: HTMLButtonElement) {
    if (sessionChanged || markRequest.current) return;
    const controller = new AbortController();
    markRequest.current = controller;
    setPendingAlert(alertId);
    setMarkError(undefined);
    try {
      const { data, error } = await client.rpc("mark_guardian_absence_alert_read", { p_alert_id: alertId })
        .abortSignal(controller.signal).returns<string | null>();
      if (controller.signal.aborted) return;
      if (error || (data !== null && typeof data !== "string")) throw error ?? new Error();
      // A fresh inbox also brings in older unread alerts when the list was full.
      if (data === null) setMarkError("This alert is no longer available.");
      if (document.activeElement === button || document.activeElement === document.body) {
        heading.current?.focus({ preventScroll: true });
      }
      refresh();
    } catch {
      if (!controller.signal.aborted) setMarkError("Could not mark the alert as read. Try again.");
    } finally {
      if (markRequest.current === controller) {
        markRequest.current = null;
        if (!controller.signal.aborted) setPendingAlert(undefined);
      }
    }
  }

  return (
    <section className="card overflow-hidden" aria-labelledby={headingId} aria-busy={!sessionChanged && !result}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <BellRing size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 id={headingId} ref={heading} tabIndex={-1} className="font-bold">Attendance alerts</h2>
            <p className="mt-1 text-sm muted">Absences recorded by the school for your linked children.</p>
            {!summary && !sessionChanged && <p role="status" className="mt-1 text-sm font-semibold">
              {inboxResult?.unreadCount !== undefined ? `${inboxResult.unreadCount} unread` : ""}
            </p>}
          </div>
        </div>
        <button type="button" aria-label="Refresh attendance alerts" disabled={!result || sessionChanged || !!pendingAlert}
          onClick={() => { setMarkError(undefined); refresh(); }}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold disabled:opacity-50">
          <RefreshCw size={15} aria-hidden="true" /> Refresh
        </button>
      </header>
      {!sessionChanged && markError && <p role="alert" className="px-4 pt-3 text-sm text-red-700 dark:text-red-300">{markError}</p>}
      {sessionChanged ? <p role="alert" className="p-4 text-sm muted">Your sign-in changed. Reopen this page to check attendance alerts.</p>
        : !result ? <p role="status" className="p-4 text-sm muted">Loading attendance alerts…</p>
          : "error" in result ? <p role="alert" className="p-4 text-sm text-red-700 dark:text-red-300">{result.error}</p>
            : result.alerts.length === 0 ? <p className="p-4 text-sm muted">No attendance alerts for your linked children.</p>
              : <ul className="divide-y divide-[var(--border)]">
                {(summary ? result.alerts.slice(0, 5) : result.alerts).map((alert) => {
                  const date = formatAttendanceDate(alert.attendance_date);
                  return (
                    <li key={alert.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                      <p className="min-w-0 break-words text-sm"><strong>{alert.student_name}</strong> was marked absent.</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <time className="text-sm muted" dateTime={alert.attendance_date}>{date}</time>
                        {!summary && (alert.read_at
                          ? <span className="text-xs font-semibold muted">Read</span>
                          : <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">Unread</span>)}
                        {!summary && alert.read_at === null && (
                          <button type="button" aria-label={`Mark as read: ${alert.student_name}, ${date}`}
                            disabled={!!pendingAlert} onClick={(event) => void markAsRead(alert.id, event.currentTarget)}
                            className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold disabled:opacity-50">
                            {pendingAlert === alert.id ? "Saving…" : "Mark as read"}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
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
