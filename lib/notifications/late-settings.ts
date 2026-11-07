import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";

export type SchoolLateAlertSettings = {
  user_id: string; school_id: string; enabled: boolean; version: number;
  history: { version: number; enabled: boolean; reason: string; actor_id: string; created_at: string }[];
};
export type SchoolLateAlertSettingsIntent = { schoolId: string; expectedVersion: number; enabled: boolean; reason: string; requestId: string };
export class LateAlertSettingsError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "conflict" | "unconfirmed" = "unconfirmed") { super(message); this.name = "LateAlertSettingsError"; }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const reason = (value: unknown): value is string => typeof value === "string" && value === value.trim() && value.length >= 5 && value.length <= 300 && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const invalid = () => new LateAlertSettingsError("Late alert settings could not be verified completely. Reload before changing them.");
export function parseSchoolLateAlertSettings(value: unknown, userId: string, schoolId: string): SchoolLateAlertSettings {
  const row = record(value);
  if (!uuid(userId) || !uuid(schoolId) || row.user_id !== userId || row.school_id !== schoolId || typeof row.enabled !== "boolean" || !version(row.version)
    || !Array.isArray(row.history) || row.history.length !== Math.min(row.version, 20) || row.version === 0 && row.enabled) throw invalid();
  for (let index = 0; index < row.history.length; index++) {
    const entry = record(row.history[index]);
    if (entry.version !== row.version - index || typeof entry.enabled !== "boolean" || !reason(entry.reason) || !uuid(entry.actor_id) || !timestamp(entry.created_at)
      || index === 0 && entry.enabled !== row.enabled) throw invalid();
  }
  return value as SchoolLateAlertSettings;
}
async function authorization(client: SupabaseClient, userId: string, signal: AbortSignal) {
  if (!uuid(userId)) throw new LateAlertSettingsError("Sign in again to manage school alerts.", "access");
  const session = await boundMfaSession(client, userId, signal).catch(() => { signal.throwIfAborted(); throw new LateAlertSettingsError("Your sign-in changed. Reopen school settings.", "access"); });
  signal.throwIfAborted();
  if (!session) throw new LateAlertSettingsError("Sign in again to manage school alerts.", "access");
  return `Bearer ${session.access_token}`;
}
function rpcError(error: { code?: string } | null, reading: boolean) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new LateAlertSettingsError("Current School Admin or Principal authenticator verification is required. Reopen settings after verification.", "access");
  if (["PT409", "40001"].includes(error.code ?? "")) throw new LateAlertSettingsError("Late alert settings changed. Reload the saved policy before editing again.", "conflict");
  if (error.code === "22023") throw new LateAlertSettingsError("Choose a valid alert setting and a 5–300 character reason.", "validation");
  throw new LateAlertSettingsError(reading ? "Late alert settings could not be loaded. Retry the access check." : "The alert policy save is unconfirmed. Retry the same frozen request to confirm its outcome.");
}
export async function loadSchoolLateAlertSettings(client: SupabaseClient, userId: string, schoolId: string, signal: AbortSignal) {
  if (!uuid(schoolId)) throw invalid();
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc("get_school_late_alert_settings", { p_school_id: schoolId }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error, true); await authorization(client, userId, signal);
  return parseSchoolLateAlertSettings(data, userId, schoolId);
}
export async function saveSchoolLateAlertSettings(client: SupabaseClient, userId: string, intent: SchoolLateAlertSettingsIntent, signal: AbortSignal) {
  if (!uuid(intent.schoolId) || !uuid(intent.requestId) || typeof intent.enabled !== "boolean" || !version(intent.expectedVersion) || intent.expectedVersion === Number.MAX_SAFE_INTEGER || typeof intent.reason !== "string" || !reason(intent.reason.trim())) {
    throw new LateAlertSettingsError("Use a valid saved version, an alert choice and a 5–300 character reason.", "validation");
  }
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc("set_school_late_alert_settings", { p_school_id: intent.schoolId, p_expected_version: intent.expectedVersion,
    p_enabled: intent.enabled, p_reason: intent.reason.trim(), p_request_id: intent.requestId }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error, false); await authorization(client, userId, signal);
  const row = record(data);
  if (row.user_id !== userId || row.school_id !== intent.schoolId || row.enabled !== intent.enabled || row.version !== intent.expectedVersion + 1
    || row.request_id !== intent.requestId || typeof row.replayed !== "boolean") throw invalid();
  return { user_id: userId, school_id: intent.schoolId, enabled: intent.enabled, version: Number(row.version), request_id: intent.requestId, replayed: row.replayed };
}
