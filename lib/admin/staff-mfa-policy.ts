import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession, readStaffMfaStatus } from "@/lib/auth/staff-mfa";

export type StaffMfaPolicy = {
  school_id: string; required: boolean; revision: number; can_manage: boolean;
  staff_count: number; enrolled_staff_count: number; enrollment_required_count: number;
  history: { id: string; revision: number; required: boolean; changed_at: string; actor_name: string | null }[];
  pending: { profile_id: string; full_name: string | null; roles: string[]; reason: StaffMfaPendingReason }[];
};
export type StaffMfaPendingReason = "not_enrolled" | "unconfirmed" | "banned" | "deleted";
/** Server caps the named list of staff still to enroll at this many rows. */
export const STAFF_MFA_PENDING_LIMIT = 200;
const pendingReasons: readonly unknown[] = ["not_enrolled", "unconfirmed", "banned", "deleted"] satisfies StaffMfaPendingReason[];
export type StaffMfaPolicyIntent = { schoolId: string; revision: number; required: boolean; requestId: string; reason: string };
export class StaffMfaPolicyError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "conflict" | "unconfirmed" = "unconfirmed") { super(message); this.name = "StaffMfaPolicyError"; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// SQL trims names with left(..., 160), which counts code points, not UTF-16 units.
const name = (value: unknown) => value === null || typeof value === "string" && [...value].length <= 160;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Request cancelled.", "AbortError"); }
function failure(error: { code?: string } | null) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new StaffMfaPolicyError("Current authenticator verification and School Admin access are required. Reopen account security before trying again.", "access");
  if (["PT409", "40001"].includes(error.code ?? "")) throw new StaffMfaPolicyError("This policy changed elsewhere. Reload its saved status before starting a new change.", "conflict");
  if (error.code === "22023") throw new StaffMfaPolicyError("This change was rejected. Check staff enrollment and use a 5–300 character reason.", "validation");
  throw new StaffMfaPolicyError("The policy change could not be confirmed. Retry the same request to check its outcome.");
}
export function parseStaffMfaPolicy(value: unknown, schoolId: string): StaffMfaPolicy {
  const row = object(value);
  if (!uuid.test(schoolId) || row.school_id !== schoolId || typeof row.required !== "boolean" || typeof row.can_manage !== "boolean"
    || !count(row.revision) || !count(row.staff_count) || !count(row.enrolled_staff_count) || !count(row.enrollment_required_count)
    || row.enrolled_staff_count + row.enrollment_required_count !== row.staff_count
    || !Array.isArray(row.history) || row.history.length > 10 || !row.history.every((entry, index) => {
      const event = object(entry);
      return typeof event.id === "string" && uuid.test(event.id) && count(event.revision) && event.revision > 0 && event.revision <= Number(row.revision)
        && (index === 0 || event.revision < Number(object((row.history as unknown[])[index - 1]).revision))
        && typeof event.required === "boolean" && typeof event.changed_at === "string" && Number.isFinite(Date.parse(event.changed_at))
        && name(event.actor_name);
    }) || new Set(row.history.map((entry) => object(entry).id)).size !== row.history.length
    || !Array.isArray(row.pending) || row.pending.length !== Math.min(row.enrollment_required_count, STAFF_MFA_PENDING_LIMIT)
    || !row.pending.every((entry) => {
      const person = object(entry);
      return typeof person.profile_id === "string" && uuid.test(person.profile_id) && pendingReasons.includes(person.reason)
        && name(person.full_name)
        && Array.isArray(person.roles) && person.roles.length > 0 && person.roles.every((role) => typeof role === "string" && role.length > 0 && role.length <= 40);
    }) || new Set(row.pending.map((entry) => object(entry).profile_id)).size !== row.pending.length) {
    throw new StaffMfaPolicyError("School authenticator policy could not be verified. Reload to try again.");
  }
  return value as StaffMfaPolicy;
}
export async function loadStaffMfaPolicy(client: SupabaseClient, userId: string, schoolId: string, signal?: AbortSignal) {
  if (!uuid.test(schoolId)) throw new StaffMfaPolicyError("Choose an authorized school.", "validation");
  const session = await boundMfaSession(client, userId, signal);
  if (!session) throw new StaffMfaPolicyError("Sign in again before checking school security.", "access");
  const result = await client.rpc("get_school_staff_mfa_policy", { p_school_id: schoolId })
    .setHeader("Authorization", `Bearer ${session.access_token}`).abortSignal(signal ?? new AbortController().signal);
  cancelled(signal); failure(result.error);
  return parseStaffMfaPolicy(result.data, schoolId);
}
export async function saveStaffMfaPolicy(client: SupabaseClient, userId: string, intent: StaffMfaPolicyIntent, signal?: AbortSignal) {
  if (!uuid.test(intent.schoolId) || !uuid.test(intent.requestId) || !count(intent.revision) || typeof intent.required !== "boolean"
    || intent.reason.trim().length < 5 || intent.reason.trim().length > 300 || /[\u0000-\u001f\u007f]/.test(intent.reason)) {
    throw new StaffMfaPolicyError("Use a 5–300 character reason and a valid saved revision.", "validation");
  }
  const status = await readStaffMfaStatus(client, userId, signal);
  if (!status?.allowed || status.current_aal !== "aal2" || status.verified_totp_count < 1) throw new StaffMfaPolicyError("Verify your authenticator before changing this policy.", "access");
  const session = await boundMfaSession(client, userId, signal);
  if (!session) throw new StaffMfaPolicyError("Sign in again before changing this policy.", "access");
  const result = await client.rpc("save_school_staff_mfa_policy", { p_school_id: intent.schoolId, p_expected_revision: intent.revision,
    p_required: intent.required, p_request_id: intent.requestId, p_reason: intent.reason.trim() })
    .setHeader("Authorization", `Bearer ${session.access_token}`).abortSignal(signal ?? new AbortController().signal);
  cancelled(signal); failure(result.error);
  const row = object(result.data);
  if (!count(row.revision) || row.required !== intent.required || typeof row.changed !== "boolean" || typeof row.replayed !== "boolean"
    || row.revision !== intent.revision + (row.changed ? 1 : 0)) throw new StaffMfaPolicyError("The policy change could not be confirmed. Retry the same request to check its outcome.");
  return { revision: row.revision, required: row.required, changed: row.changed, replayed: row.replayed };
}
