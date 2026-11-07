import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";

export type GateAlertPreference = {
  student_id: string; student_name: string; preference_id: string; arrival: boolean; exit: boolean; version: number;
};
export class GateAlertPreferencesError extends Error {
  constructor(message: string, readonly code: "access" | "conflict" | "unconfirmed" = "unconfirmed") {
    super(message); this.name = "GateAlertPreferencesError";
  }
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const invalid = () => new GateAlertPreferencesError("Gate preferences could not be verified. Refresh gate preferences before saving again.");

function preference(value: unknown): GateAlertPreference {
  const row = object(value);
  if (!uuid(row.student_id) || !uuid(row.preference_id) || typeof row.student_name !== "string" || !row.student_name.trim()
    || typeof row.arrival_enabled !== "boolean" || typeof row.exit_enabled !== "boolean"
    || !Number.isSafeInteger(row.version) || Number(row.version) < 0) throw invalid();
  return { student_id: row.student_id, preference_id: row.preference_id, student_name: row.student_name,
    arrival: row.arrival_enabled, exit: row.exit_enabled, version: Number(row.version) };
}
function rpcError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "42501") throw new GateAlertPreferencesError("Your linked-child access changed. Refresh gate preferences after signing in.", "access");
  if (error.code === "PT409") throw new GateAlertPreferencesError("Gate preferences changed in another session. Refresh to check the saved choices before saving again.", "conflict");
  if (["PGRST202", "42883"].includes(error.code ?? "")) throw new GateAlertPreferencesError("Gate preferences need the latest school update. Contact your administrator.");
  throw new GateAlertPreferencesError("The save could not be confirmed. Refresh gate preferences before saving again.");
}
async function authorization(client: SupabaseClient, userId: string, signal: AbortSignal) {
  if (!uuid(userId)) throw new GateAlertPreferencesError("Sign in again to manage gate alerts.", "access");
  const session = await boundMfaSession(client, userId, signal).catch(error => {
    signal.throwIfAborted();
    throw new GateAlertPreferencesError(error instanceof Error ? error.message : "Sign in again to manage gate alerts.", "access");
  });
  if (!session) throw new GateAlertPreferencesError("Sign in again to manage gate alerts.", "access");
  signal.throwIfAborted();
  return `Bearer ${session.access_token}`;
}

export async function loadGateAlertPreferences(client: SupabaseClient, userId: string, signal: AbortSignal): Promise<GateAlertPreference[]> {
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc("get_my_gate_alert_preferences").setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error);
  const row = object(data);
  if (row.user_id !== userId || !Array.isArray(row.children)) throw invalid();
  const children = row.children.map(preference);
  if (new Set(children.map(child => child.student_id)).size !== children.length
    || new Set(children.map(child => child.preference_id)).size !== children.length) throw invalid();
  return children;
}

export async function saveGateAlertPreferences(client: SupabaseClient, userId: string, next: GateAlertPreference, signal: AbortSignal): Promise<GateAlertPreference> {
  if (!uuid(next.student_id) || !uuid(next.preference_id) || typeof next.arrival !== "boolean" || typeof next.exit !== "boolean"
    || !Number.isSafeInteger(next.version) || next.version < 0) throw invalid();
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc("set_my_gate_alert_preferences", { p_preference_id: next.preference_id,
    p_expected_version: next.version, p_arrival_enabled: next.arrival, p_exit_enabled: next.exit }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error);
  await authorization(client, userId, signal);
  if (object(data).user_id !== userId) throw invalid();
  const saved = preference(data);
  if (saved.preference_id !== next.preference_id || saved.student_id !== next.student_id || saved.arrival !== next.arrival || saved.exit !== next.exit
    || saved.version < next.version || saved.version > next.version + 1) throw invalid();
  return saved;
}
