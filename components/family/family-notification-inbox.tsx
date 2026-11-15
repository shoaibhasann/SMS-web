"use client";

import Link from "next/link";
import { BellRing, CalendarDays, LogIn, LogOut, Megaphone, NotebookPen, Receipt, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";
import { GateAlertPreferences } from "@/components/family/gate-alert-preferences";
import {
  familyNotificationsChangedEvent, familyNotificationsHref, loadFamilyNotificationInbox,
  markAllFamilyNotificationsRead, markFamilyNotificationRead, notificationHref, notifyFamilyNotificationsChanged,
  type FamilyNotification, type FamilyNotificationCursor, type FamilyNotificationInbox as Inbox,
  type FamilyNotificationRole,
} from "@/lib/notifications/family";
import { SlidingIndicator } from "@/components/ui/sliding-indicator";

type Props = { userId: string; role: FamilyNotificationRole; summary?: boolean };
type Result = { inbox: Inbox } | { error: string };
type MarkTarget = { kind: "all" } | { kind: "single"; notification: FamilyNotification };
const control = "min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-50";
const format = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const gateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function eventDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : format.format(date);
}

export function FamilyNotificationInbox(props: Props) {
  return <OwnFamilyNotificationInbox key={`${props.userId}:${props.role}`} {...props} />;
}

function OwnFamilyNotificationInbox({ userId, role, summary = false }: Props) {
  const [client] = useState(createClient);
  const [filter, setFilter] = useState<"All" | "Unread">("All");
  const [cursor, setCursor] = useState<FamilyNotificationCursor | null>(null);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; result: Result }>();
  const [sessionChanged, setSessionChanged] = useState(false);
  const [pendingMark, setPendingMark] = useState<MarkTarget>();
  const [markError, setMarkError] = useState<string>();
  const markRequest = useRef<AbortController | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const key = `${filter}:${revision}:${summary}:${cursor ? `${cursor.created_at}:${cursor.kind}:${cursor.id}` : "latest"}`;
  const result = loaded?.key === key ? loaded.result : undefined;
  const inbox = result && "inbox" in result ? result.inbox : undefined;
  const notifications = inbox?.notifications ?? [];

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        readRequest.current?.abort(); markRequest.current?.abort(); setSessionChanged(true);
      }
    });
    return () => { readRequest.current?.abort(); markRequest.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId]);

  useEffect(() => {
    if (sessionChanged) return;
    const controller = new AbortController(); readRequest.current = controller;
    loadFamilyNotificationInbox(client, { userId, role, unreadOnly: filter === "Unread", cursor, limit: summary ? 5 : 30 }, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setLoaded({ key, result: { inbox: data } }); }, () => {
        if (!controller.signal.aborted) setLoaded({ key, result: { error: "Notifications could not be loaded. Refresh to try again." } });
      });
    return () => { controller.abort(); if (readRequest.current === controller) readRequest.current = null; };
  }, [client, userId, role, filter, cursor, summary, key, sessionChanged]);

  useEffect(() => {
    if (sessionChanged) return;
    const refresh = () => { setCursor(null); setRevision((value) => value + 1); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: unknown; role?: unknown; keepCursor?: unknown }>).detail;
      if (detail?.userId === userId && detail.role === role) { if (detail.keepCursor === true) setRevision((value) => value + 1); else refresh(); }
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", refresh);
    window.addEventListener(familyNotificationsChangedEvent, changed);
    return () => {
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", refresh);
      window.removeEventListener(familyNotificationsChangedEvent, changed);
    };
  }, [role, userId, sessionChanged]);

  function refresh() { setMarkError(undefined); setCursor(null); setRevision((value) => value + 1); }

  async function markRead(target: MarkTarget, button: HTMLButtonElement) {
    if (sessionChanged || markRequest.current) return;
    const controller = new AbortController(); markRequest.current = controller; setPendingMark(target); setMarkError(undefined);
    try {
      if (target.kind === "all") await markAllFamilyNotificationsRead(client, role, userId, controller.signal);
      else {
        const readAt = await markFamilyNotificationRead(client, role, target.notification.kind, target.notification.id, userId, controller.signal);
        if (!controller.signal.aborted && readAt === null) setMarkError("This notification is no longer available.");
      }
      if (controller.signal.aborted) return;
      if (document.activeElement === button || document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
      // A single mark refetches the current page; Mark all returns to the newest.
      notifyFamilyNotificationsChanged(userId, role, target.kind === "single" ? { keepCursor: true } : undefined);
    } catch {
      if (!controller.signal.aborted) setMarkError(target.kind === "all"
        ? "Could not mark all notifications as read. Try again." : "Could not mark the notification as read. Try again.");
    } finally {
      if (markRequest.current === controller) { markRequest.current = null; if (!controller.signal.aborted) setPendingMark(undefined); }
    }
  }

  return <div className="space-y-4">
    {role === "parent" && !summary && <GateAlertPreferences userId={userId} />}
    <section className="card overflow-hidden" aria-labelledby={headingId} aria-busy={!sessionChanged && !result}>
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--primary)_10%,var(--surface))] text-[var(--primary)]"><BellRing size={19} aria-hidden="true" /></span>
        <div><h2 id={headingId} ref={heading} tabIndex={-1} className="font-bold">{summary ? "School updates" : "Notifications"}</h2>
          <p className="mt-1 text-sm muted">{role === "parent" ? "School and fee updates for your linked children." : "Homework, school updates and fee activity."}</p>
          {!sessionChanged && inbox && <p role="status" className="mt-1 text-sm font-semibold">{inbox.unread_count} unread</p>}
        </div>
      </div>
      <button type="button" className={`inline-flex items-center gap-2 ${control}`} aria-label="Refresh notifications"
        disabled={!result || sessionChanged || !!pendingMark} onClick={refresh}><RefreshCw size={15} aria-hidden="true" />Refresh</button>
    </header>
    {!summary && !sessionChanged && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2">
      <div role="group" aria-label="Filter notifications" className="inline-flex rounded-xl border border-[var(--border)] p-0.5"><SlidingIndicator className="rounded-[10px] bg-[color-mix(in_srgb,var(--primary)_12%,var(--surface))] [--slider-disabled-opacity:.5]" />
        {(["All", "Unread"] as const).map((option) => <button key={option} type="button" aria-pressed={filter === option} disabled={!!pendingMark}
          onClick={() => { setFilter(option); setCursor(null); setMarkError(undefined); }}
          className="min-h-11 rounded-[10px] px-3 text-sm font-semibold aria-pressed:bg-[color-mix(in_srgb,var(--primary)_12%,var(--surface))] aria-pressed:text-[color-mix(in_srgb,var(--primary)_80%,var(--text))] disabled:opacity-50">{option}</button>)}
      </div>
      <button type="button" className={control} disabled={!inbox?.unread_count || !!pendingMark}
        onClick={(event) => void markRead({ kind: "all" }, event.currentTarget)}>{pendingMark?.kind === "all" ? "Marking all as read…" : "Mark all as read"}</button>
    </div>}
    {!sessionChanged && markError && <p role="alert" className="px-4 pt-3 text-sm text-red-700 dark:text-red-300">{markError}</p>}
    {sessionChanged ? <p role="alert" className="p-4 text-sm muted">Your sign-in changed. Reopen this page to check notifications.</p>
      : !result ? <LoadingState variant="list" className="p-4 text-sm muted">Loading notifications…</LoadingState>
        : "error" in result ? <div className="space-y-3 p-4"><p role="alert" className="text-sm text-danger">{result.error}</p>
          <button type="button" className="btn btn-secondary" onClick={refresh}>Try again</button></div>
          : notifications.length === 0 ? <p className="p-4 text-sm muted">{filter === "Unread" ? "No unread notifications." : "No notifications available."}</p>
            : <ul className="divide-y divide-[var(--border)]">{notifications.map((notification) => {
              const gate = notification.kind === "gate_arrival" || notification.kind === "gate_exit";
              const due = notification.kind === "fee_due";
              const payment = notification.kind === "fee_payment";
              const exam = notification.kind === "exam_schedule";
              const date = gate && notification.occurred_at ? `${gateTime.format(new Date(notification.occurred_at))} IST` : eventDate(notification.event_date);
              const type = notification.kind === "gate_arrival" ? "Arrival" : notification.kind === "gate_exit" ? "Exit"
                : notification.kind === "late" ? "Late attendance" : notification.kind === "absence" ? "Attendance"
                  : notification.kind === "result_published" ? "Result" : notification.kind === "announcement" ? "Announcement"
                    : notification.kind === "homework_assigned" ? "Homework"
                      : due ? notification.status === "overdue" ? "Fee overdue" : "Fee due"
                        : payment ? "Fee payment"
                          : exam ? notification.status === "rescheduled" ? "Exam schedule updated" : "Exam scheduled" : "Leave";
              return <li key={`${notification.kind}:${notification.id}`} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs"><span className="inline-flex items-center gap-1 font-semibold muted">
                    {gate && (notification.kind === "gate_arrival" ? <LogIn size={13} aria-hidden="true" /> : <LogOut size={13} aria-hidden="true" />)}
                    {notification.kind === "announcement" && <Megaphone size={13} aria-hidden="true" />}
                    {notification.kind === "homework_assigned" && <NotebookPen size={13} aria-hidden="true" />}
                    {exam && <CalendarDays size={13} aria-hidden="true" />}
                    {(due || payment) && <Receipt size={13} aria-hidden="true" />}{type}</span>
                    {notification.delayed && <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 muted">Delayed update</span>}
                    {!notification.read_at && <span className="rounded-full bg-[color-mix(in_srgb,var(--primary)_12%,var(--surface))] px-2 py-0.5 font-semibold text-[color-mix(in_srgb,var(--primary)_80%,var(--text))]">Unread</span>}
                    {notification.read_at && !summary && <span className="muted">Read</span>}
                  </div>
                  <Link href={notificationHref(notification, role)} className="block min-h-11 rounded-md py-1 text-sm leading-6 hover:text-[var(--primary)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
                    <strong className="block break-words">{notification.title}</strong>{notification.student_name && <>{" "}<span className="break-words muted">{notification.student_name}</span></>}
                  </Link>
                  <time className="block text-xs muted" dateTime={notification.occurred_at ?? notification.event_date}>{due ? `Due ${date}` : exam ? `Exam date · ${date}` : date}</time>
                </div>
                {!summary && notification.read_at === null && <button type="button" className={control} disabled={!!pendingMark}
                  aria-label={`Mark as read: ${[notification.student_name, notification.title, date].filter(Boolean).join(", ")}`}
                  onClick={(event) => void markRead({ kind: "single", notification }, event.currentTarget)}>
                  {pendingMark?.kind === "single" && pendingMark.notification.kind === notification.kind && pendingMark.notification.id === notification.id ? "Saving…" : "Mark as read"}
                </button>}
              </li>;
            })}</ul>}
    {!sessionChanged && !summary && inbox && (cursor || inbox.next_cursor) && <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3">
      {cursor ? <button type="button" className={control} disabled={!!pendingMark} onClick={() => { refresh(); heading.current?.focus(); }}>Latest notifications</button> : <span className="text-xs muted">Latest notifications</span>}
      {inbox.next_cursor && <button type="button" className={control} disabled={!!pendingMark} onClick={() => { setCursor(inbox.next_cursor); heading.current?.focus(); }}>Older notifications</button>}
    </footer>}
    {summary && !sessionChanged && <footer className="border-t border-[var(--border)] px-4 py-2"><Link href={familyNotificationsHref(role)}
      className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--primary)] hover:underline">View all notifications</Link></footer>}
  </section></div>;
}
