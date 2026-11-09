import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";

export type FamilyNotificationRole = "parent" | "student";
export type FamilyNotificationKind = "absence" | "late" | "result_published" | "leave_decision" | "gate_arrival" | "gate_exit" | "announcement";
export type FamilyNotificationCursor = { created_at: string; kind: FamilyNotificationKind; id: string };
export type FamilyNotification = {
  id: string; kind: FamilyNotificationKind; student_id: string | null; student_name: string | null;
  created_at: string; read_at: string | null; event_date: string; source_id: string;
  status: "absent" | "late" | "published" | "approved" | "rejected" | "IN" | "OUT"; title: string; assessment_id: string | null;
  occurred_at: string | null; delayed: boolean;
};
export type FamilyNotificationInbox = {
  notifications: FamilyNotification[]; unread_count: number; next_cursor: FamilyNotificationCursor | null;
};

export const familyNotificationsChangedEvent = "sms:family-notifications-changed";
const kinds: readonly string[] = ["absence", "late", "result_published", "leave_decision", "gate_arrival", "gate_exit", "announcement"];
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && value.includes("T");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const invalid = () => new Error("The notification records could not be verified. Refresh to try again.");

function role(value: FamilyNotificationRole) {
  if (value !== "parent" && value !== "student") throw new Error("Choose a valid family notification view.");
  return value;
}
function count(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw invalid();
  return number;
}
function cursor(value: unknown): FamilyNotificationCursor {
  const row = record(value);
  if (!uuid(row.id) || !timestamp(row.created_at) || !kinds.includes(row.kind as string)) throw invalid();
  return { id: row.id, created_at: row.created_at, kind: row.kind as FamilyNotificationKind };
}
function isGate(kind: FamilyNotificationKind) { return kind === "gate_arrival" || kind === "gate_exit"; }
function guardianOnly(kind: FamilyNotificationKind) { return isGate(kind) || kind === "late"; }
function notification(value: unknown): FamilyNotification {
  const row = record(value);
  const studentScopeMatches = row.kind === "announcement"
    ? row.student_id === null && row.student_name === null
    : uuid(row.student_id) && typeof row.student_name === "string" && !!row.student_name.trim();
  const date = typeof row.event_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.event_date)
    && !row.event_date.startsWith("0000") && Number.isFinite(Date.parse(`${row.event_date}T00:00:00Z`))
    && new Date(`${row.event_date}T00:00:00Z`).toISOString().slice(0, 10) === row.event_date;
  if (!uuid(row.id) || !studentScopeMatches || !uuid(row.source_id) || !timestamp(row.created_at)
    || !(row.read_at === null || timestamp(row.read_at)) || !date
    || typeof row.title !== "string" || !row.title.trim() || typeof row.delayed !== "boolean"
    || !(row.kind === "gate_arrival" || row.kind === "gate_exit" ? timestamp(row.occurred_at) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(row.occurred_at) : row.occurred_at === null && row.delayed === false)
    || !(row.kind === "absence" && row.status === "absent" && row.assessment_id === null
      || row.kind === "late" && row.status === "late" && row.assessment_id === null
      || row.kind === "result_published" && row.status === "published" && uuid(row.assessment_id)
      || row.kind === "announcement" && row.status === "published" && row.assessment_id === null && row.source_id === row.id
      || row.kind === "leave_decision" && ["approved", "rejected"].includes(row.status as string) && row.assessment_id === null
      || row.kind === "gate_arrival" && row.status === "IN" && row.assessment_id === null
      || row.kind === "gate_exit" && row.status === "OUT" && row.assessment_id === null)) throw invalid();
  return {
    id: row.id, kind: row.kind as FamilyNotificationKind, student_id: row.student_id as string | null, student_name: row.student_name as string | null,
    created_at: row.created_at, read_at: row.read_at as string | null, event_date: row.event_date as string,
    source_id: row.source_id, status: row.status as FamilyNotification["status"], title: row.title, assessment_id: row.assessment_id as string | null,
    occurred_at: row.occurred_at as string | null, delayed: row.delayed as boolean,
  };
}
function rpcError(error: { code?: string } | null) {
  if (!error) return;
  if (["PGRST202", "42883"].includes(error.code ?? "")) throw new Error("Notifications need the latest school update. Contact your administrator.");
  if (error.code === "42501") throw new Error("Your notification access changed. Reopen this page after signing in.");
  throw new Error("Notifications could not be confirmed. Refresh to check the saved status before retrying.");
}

async function authorization(client: SupabaseClient, userId: string, signal?: AbortSignal) {
  if (!uuid(userId)) throw new Error("Sign in again to check notifications.");
  const session = await boundMfaSession(client, userId, signal);
  if (!session) throw new Error("Sign in again to check notifications.");
  signal?.throwIfAborted();
  return `Bearer ${session.access_token}`;
}

export async function loadFamilyNotificationInbox(client: SupabaseClient, options: {
  userId: string; role: FamilyNotificationRole; unreadOnly?: boolean; cursor?: FamilyNotificationCursor | null; limit?: number;
}, signal?: AbortSignal): Promise<FamilyNotificationInbox> {
  const limit = options.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (options.unreadOnly !== undefined && typeof options.unreadOnly !== "boolean")) throw invalid();
  const before = options.cursor ? cursor(options.cursor) : null;
  if (options.role === "student" && before && guardianOnly(before.kind)) throw invalid();
  const header = await authorization(client, options.userId, signal);
  const request = client.rpc("get_family_notification_inbox_v4", {
    p_role: role(options.role), p_unread_only: options.unreadOnly ?? false, p_limit: limit,
    p_before_created_at: before?.created_at ?? null, p_before_kind: before?.kind ?? null, p_before_id: before?.id ?? null,
  }).setHeader("Authorization", header);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  signal?.throwIfAborted(); rpcError(error);
  await authorization(client, options.userId, signal);
  const result = record(data);
  if (result.user_id !== options.userId || result.role !== options.role || !Array.isArray(result.notifications) || result.notifications.length > limit) throw invalid();
  const rows = result.notifications.map(notification);
  if (new Set(rows.map((row) => `${row.kind}:${row.id}`)).size !== rows.length
    || options.unreadOnly && rows.some((row) => row.read_at !== null)
    || options.role === "student" && rows.some(row => guardianOnly(row.kind))) throw invalid();
  const next = result.next_cursor === null ? null : cursor(result.next_cursor);
  const last = rows.at(-1);
  if (next && (!last || next.id !== last.id || next.kind !== last.kind || next.created_at !== last.created_at)) throw invalid();
  if (next && before && next.id === before.id && next.kind === before.kind && next.created_at === before.created_at) throw invalid();
  return { notifications: rows, unread_count: count(result.unread_count), next_cursor: next };
}

export async function loadFamilyNotificationUnreadCount(client: SupabaseClient, view: FamilyNotificationRole, userId: string, signal?: AbortSignal) {
  const header = await authorization(client, userId, signal);
  const request = client.rpc("get_family_notification_unread_count_v4", { p_role: role(view) }).setHeader("Authorization", header);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  signal?.throwIfAborted(); rpcError(error); await authorization(client, userId, signal); return count(data);
}

export async function markFamilyNotificationRead(client: SupabaseClient, view: FamilyNotificationRole,
  kind: FamilyNotificationKind, id: string, userId: string, signal?: AbortSignal): Promise<string | null> {
  if (!kinds.includes(kind) || !uuid(id) || view === "student" && guardianOnly(kind)) throw invalid();
  const header = await authorization(client, userId, signal);
  const request = client.rpc("mark_family_notification_read_v4", { p_role: role(view), p_kind: kind, p_id: id }).setHeader("Authorization", header);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  signal?.throwIfAborted(); rpcError(error);
  await authorization(client, userId, signal);
  if (data !== null && !timestamp(data)) throw invalid();
  return data;
}

export async function markAllFamilyNotificationsRead(client: SupabaseClient, view: FamilyNotificationRole, userId: string, signal?: AbortSignal) {
  const header = await authorization(client, userId, signal);
  const request = client.rpc("mark_all_family_notifications_read_v4", { p_role: role(view) }).setHeader("Authorization", header);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  signal?.throwIfAborted(); rpcError(error); await authorization(client, userId, signal); return count(data);
}

export function familyNotificationsHref(view: FamilyNotificationRole) {
  return role(view) === "parent" ? "/modules/notifications?view=guardian" : "/modules/notifications";
}

export async function loadFamilyAnnouncement(client: SupabaseClient, options: {
  id: string; role: FamilyNotificationRole; userId: string;
}, signal: AbortSignal) {
  if (!uuid(options.id)) throw invalid();
  const header = await authorization(client, options.userId, signal);
  const { data, error } = await client.rpc("get_family_announcement", {
    p_role: role(options.role), p_notice_id: options.id,
  }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted();
  rpcError(error);
  await authorization(client, options.userId, signal);
  if (data === null) return null;
  const row = record(data);
  if (row.id !== options.id || !timestamp(row.published_at) || typeof row.title !== "string"
    || !row.title.trim() || typeof row.content !== "string") throw invalid();
  return { id: options.id, title: row.title, content: row.content, published_at: row.published_at };
}

export function notificationHref(value: FamilyNotification, view: FamilyNotificationRole) {
  const row = notification(value), params = new URLSearchParams();
  if (row.student_id) params.set("child", row.student_id);
  if (view === "student" && guardianOnly(row.kind)) throw invalid();
  if (role(view) === "parent") params.set("view", "guardian");
  if (row.kind === "announcement") {
    params.set("notice", row.source_id);
    return `/modules/notices?${params}`;
  }
  const path = row.kind === "absence" || guardianOnly(row.kind) ? "attendance" : row.kind === "result_published" ? "results" : "student-leave";
  if (row.kind === "result_published") params.set("assessment", row.assessment_id!);
  if (row.kind === "leave_decision") params.set("request", row.source_id);
  return `/modules/${path}?${params}`;
}

export function notifyFamilyNotificationsChanged(userId: string, view: FamilyNotificationRole) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(familyNotificationsChangedEvent, { detail: { userId, role: role(view) } }));
}
