import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyNotificationRole } from "@/lib/notifications/family";

export type NativePushRole = FamilyNotificationRole;
export type NativePushPreferences = { enabled: boolean; absence: boolean; result_published: boolean; leave_decision: boolean; version: number };
export type NativePushDevice = { id: string; platform: "android" | "ios"; label: string; created_at: string; last_seen_at: string; revoked_at: string | null };
export type NativePushSettings = { preferences: NativePushPreferences; devices: NativePushDevice[] };

export class NativePushError extends Error {
  constructor(message: string, public code = "") { super(message); this.name = "NativePushError"; }
}
const invalid = () => new NativePushError("Mobile notification settings could not be verified. Refresh to try again.");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sensitive = ["token", "fcm_token", "installation_secret", "installation_secret_hash", "session_id"];
function checkedRole(role: NativePushRole) {
  if (role !== "parent" && role !== "student") throw new NativePushError("Choose a valid family notification view.", "22023");
  return role;
}
function preferences(value: unknown): NativePushPreferences {
  const row = object(value);
  if (![row.enabled, row.absence, row.result_published, row.leave_decision].every((item) => typeof item === "boolean")
    || !Number.isSafeInteger(row.version) || (row.version as number) < 0) throw invalid();
  return { enabled: row.enabled as boolean, absence: row.absence as boolean, result_published: row.result_published as boolean,
    leave_decision: row.leave_decision as boolean, version: row.version as number };
}
function settings(value: unknown): NativePushSettings {
  const row = object(value);
  if (!Array.isArray(row.devices) || row.devices.length > 50 || sensitive.some((key) => key in row)) throw invalid();
  const devices = row.devices.map((item): NativePushDevice => {
    const device = object(item);
    if (!uuid(device.id) || !["android", "ios"].includes(device.platform as string) || typeof device.label !== "string"
      || !device.label.trim() || Array.from(device.label).length > 80 || !timestamp(device.created_at) || !timestamp(device.last_seen_at)
      || !(device.revoked_at === null || timestamp(device.revoked_at)) || sensitive.some((key) => key in device)) throw invalid();
    return { id: device.id, platform: device.platform as NativePushDevice["platform"], label: device.label,
      created_at: device.created_at, last_seen_at: device.last_seen_at, revoked_at: device.revoked_at as string | null };
  });
  if (new Set(devices.map((device) => device.id)).size !== devices.length) throw invalid();
  return { preferences: preferences(row.preferences), devices };
}
function rpcError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "PT409") throw new NativePushError("Push settings changed in another session. Refresh push settings before saving again. Your selection is kept.", error.code);
  if (error.code === "42501") throw new NativePushError("Your mobile notification access changed. Reopen settings after signing in.", error.code);
  if (["PGRST202", "42883"].includes(error.code ?? "")) throw new NativePushError("Mobile notification settings need the latest school update. Contact your administrator.", error.code);
  throw new NativePushError("The change could not be confirmed. Refresh to check the saved settings before retrying.", error.code);
}

export async function loadNativePushSettings(client: SupabaseClient, role: NativePushRole, signal?: AbortSignal): Promise<NativePushSettings> {
  const request = client.rpc("get_my_family_push_settings", { p_role: checkedRole(role) });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  rpcError(error); return settings(data);
}
export async function saveNativePushPreferences(client: SupabaseClient, role: NativePushRole, value: NativePushPreferences, signal?: AbortSignal): Promise<NativePushSettings> {
  const next = preferences(value);
  const request = client.rpc("set_my_family_push_preferences", { p_role: checkedRole(role), p_enabled: next.enabled,
    p_absence: next.absence, p_result_published: next.result_published, p_leave_decision: next.leave_decision, p_expected_version: next.version });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  rpcError(error);
  const saved = settings(data);
  if (["enabled", "absence", "result_published", "leave_decision"].some((key) => saved.preferences[key as keyof NativePushPreferences] !== next[key as keyof NativePushPreferences])
    || saved.preferences.version < next.version) throw invalid();
  return saved;
}
export async function revokeNativePushDevice(client: SupabaseClient, role: NativePushRole, deviceId: string, signal?: AbortSignal): Promise<boolean> {
  if (!uuid(deviceId)) throw new NativePushError("Choose a valid mobile device.", "22023");
  const request = client.rpc("revoke_my_family_push_device", { p_role: checkedRole(role), p_device_id: deviceId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  rpcError(error);
  if (typeof data !== "boolean") throw invalid();
  return data;
}
