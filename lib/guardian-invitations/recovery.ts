import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";
import { normalizeIndianMobile } from "@/lib/auth/phone";

export type GuardianRecoveryStatus = "pending" | "approved" | "rejected" | "cancelled" | "accepted" | "expired";
export type GuardianRecoveryCase = {
  id: string; parent_id: string; guardian_name: string | null; channel: "email" | "phone"; contact: string;
  status: GuardianRecoveryStatus; version: number; expires_at: string; requires_mfa: boolean;
  created_at: string; requester_name: string | null; reviewer_name: string | null; can_review: boolean; can_cancel: boolean;
};
export type GuardianRecoveryWorkspace = {
  school_id: string; guardians: { parent_id: string; name: string | null; linked_children: number; requires_mfa: boolean }[];
  cases: GuardianRecoveryCase[]; cases_limit: number; total_cases: number;
};
export type GuardianRecoveryClaim = { school_name: string; requires_mfa: boolean; linked_children: number; expires_at: string };
export type RecoveryRequest = { kind: "request"; schoolId: string; parentId: string; channel: "email" | "phone"; contact: string; reason: string; requestId: string };
export type RecoveryReview = { kind: "review"; caseId: string; version: number; decision: "approve" | "reject" | "cancel"; reason: string; requestId: string; token: string | null };
export type RecoveryIntent = RecoveryRequest | RecoveryReview;
export class GuardianRecoveryError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "conflict" | "unavailable" | "unconfirmed" = "unconfirmed") { super(message); this.name = "GuardianRecoveryError"; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern = /^[0-9a-f]{64}$/;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const name = (value: unknown) => value === null || text(value, 200);
const date = (value: unknown): value is string => text(value, 60) && Number.isFinite(Date.parse(value));
const statuses: GuardianRecoveryStatus[] = ["pending", "approved", "rejected", "cancelled", "accepted", "expired"];
function invalid() { return new GuardianRecoveryError("Recovery records could not be verified. Reload to check their current status."); }
function failure(error: { code?: string } | null) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new GuardianRecoveryError("Verify the correct account and authenticator. School recovery requires authorized, independently verified staff and the exact verified recipient.", "access");
  if (error.code === "22023") throw new GuardianRecoveryError("Check the contact, guardian and reason. Recovery cannot merge existing school accounts.", "validation");
  if (["PT409", "40001"].includes(error.code ?? "")) throw new GuardianRecoveryError("Access or recovery details changed. Reload and review the current records before starting another request.", "conflict");
  if (["55000", "P0001"].includes(error.code ?? "")) throw new GuardianRecoveryError("This recovery is expired, cancelled, already used by another account or no longer available. Contact your school.", "unavailable");
  throw new GuardianRecoveryError("The recovery result is unknown. Retry the exact request before starting another change.");
}
async function rpc(client: SupabaseClient, userId: string, fn: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const session = await boundMfaSession(client, userId, signal);
  if (!session) throw new GuardianRecoveryError("Sign in again to continue recovery.", "access");
  const result = await client.rpc(fn, args).setHeader("Authorization", `Bearer ${session.access_token}`).abortSignal(signal ?? new AbortController().signal);
  if (signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
  failure(result.error); return result.data;
}
export function recoveryContact(channel: "email" | "phone", value: string) {
  if (channel === "phone") return normalizeIndianMobile(value);
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
export function newGuardianRecoveryToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join(""); }
export function guardianRecoveryUrl(token: string, origin: string) {
  if (!tokenPattern.test(token)) throw invalid();
  const url = new URL("/guardian-recover", origin); url.hash = `token=${token}`; return url.href;
}
export function parseRecoveryWorkspace(value: unknown, schoolId: string): GuardianRecoveryWorkspace {
  const row = record(value);
  if (row.school_id !== schoolId || !uuid.test(schoolId) || !Array.isArray(row.guardians) || row.guardians.length > 20
    || !row.guardians.every(item => { const g = record(item); return typeof g.parent_id === "string" && uuid.test(g.parent_id) && name(g.name) && count(g.linked_children) && g.linked_children > 0 && typeof g.requires_mfa === "boolean"; })
    || new Set(row.guardians.map(item => record(item).parent_id)).size !== row.guardians.length
    || !Array.isArray(row.cases) || row.cases_limit !== 50 || row.cases.length > 50 || !count(row.total_cases) || row.total_cases < row.cases.length
    || !row.cases.every(item => { const c = record(item); return typeof c.id === "string" && uuid.test(c.id) && typeof c.parent_id === "string" && uuid.test(c.parent_id)
      && name(c.guardian_name) && ["email", "phone"].includes(String(c.channel)) && typeof c.contact === "string" && recoveryContact(c.channel as "email" | "phone", c.contact) === c.contact
      && statuses.includes(c.status as GuardianRecoveryStatus) && count(c.version) && c.version > 0 && date(c.expires_at) && date(c.created_at)
      && typeof c.requires_mfa === "boolean" && name(c.requester_name) && name(c.reviewer_name) && typeof c.can_review === "boolean" && typeof c.can_cancel === "boolean"; })
    || new Set(row.cases.map(item => record(item).id)).size !== row.cases.length) throw invalid();
  return value as GuardianRecoveryWorkspace;
}
export async function loadGuardianRecovery(client: SupabaseClient, userId: string, schoolId: string, admissionNo: string, signal?: AbortSignal) {
  if (!uuid.test(schoolId) || !text(admissionNo, 100)) throw invalid();
  return parseRecoveryWorkspace(await rpc(client, userId, "get_guardian_recovery_workspace", { p_school_id: schoolId, p_admission_no: admissionNo.trim() || null }, signal), schoolId);
}
export async function saveGuardianRecovery(client: SupabaseClient, userId: string, intent: RecoveryIntent, signal?: AbortSignal) {
  if (!["request", "review"].includes(intent.kind) || !uuid.test(intent.requestId) || !text(intent.reason, 300) || intent.reason.trim().length < 5) throw new GuardianRecoveryError("Use a 5–300 character verification/review reason.", "validation");
  let value: unknown;
  if (intent.kind === "request") {
    if (!uuid.test(intent.schoolId) || !uuid.test(intent.parentId) || !["email", "phone"].includes(intent.channel) || recoveryContact(intent.channel, intent.contact) !== intent.contact) throw new GuardianRecoveryError("Select a guardian and enter a valid new contact.", "validation");
    value = await rpc(client, userId, "request_guardian_account_recovery", { p_school_id: intent.schoolId, p_parent_id: intent.parentId, p_channel: intent.channel, p_contact: intent.contact, p_reason: intent.reason, p_request_id: intent.requestId }, signal);
  } else {
    if (!uuid.test(intent.caseId) || !count(intent.version) || intent.version < 1 || !["approve", "reject", "cancel"].includes(intent.decision) || (intent.decision === "approve" ? !tokenPattern.test(intent.token ?? "") : intent.token !== null)) throw invalid();
    value = await rpc(client, userId, "review_guardian_account_recovery", { p_case_id: intent.caseId, p_expected_version: intent.version, p_decision: intent.decision, p_reason: intent.reason, p_request_id: intent.requestId, p_claim_token: intent.token }, signal);
  }
  const row = record(value);
  const expectedStatus = intent.kind === "request" ? "pending" : { approve: "approved", reject: "rejected", cancel: "cancelled" }[intent.decision];
  const approval = intent.kind === "review" && intent.decision === "approve";
  if (typeof row.id !== "string" || !uuid.test(row.id) || row.status !== expectedStatus || !count(row.version) || row.version < 1 || !date(row.expires_at)
    || (!approval && row.token !== undefined && row.token !== null)
    || (intent.kind === "review" && (row.id !== intent.caseId || row.version !== intent.version + 1 || (intent.decision === "approve" && row.token !== intent.token)))) throw invalid();
  return { id: row.id, status: row.status as GuardianRecoveryStatus, version: row.version, expires_at: row.expires_at, token: typeof row.token === "string" ? row.token : null };
}
export async function loadGuardianRecoveryClaim(client: SupabaseClient, userId: string, token: string, signal?: AbortSignal): Promise<GuardianRecoveryClaim> {
  if (!tokenPattern.test(token)) throw invalid();
  const value = await rpc(client, userId, "get_my_guardian_recovery_claim", { p_token: token }, signal), row = record(value);
  if (!text(row.school_name, 160) || !row.school_name || typeof row.requires_mfa !== "boolean" || !count(row.linked_children) || row.linked_children < 1 || !date(row.expires_at)) throw invalid();
  return value as GuardianRecoveryClaim;
}
export async function acceptGuardianRecovery(client: SupabaseClient, userId: string, token: string, requestId: string, signal?: AbortSignal) {
  if (!tokenPattern.test(token) || !uuid.test(requestId)) throw invalid();
  const row = record(await rpc(client, userId, "accept_guardian_account_recovery", { p_token: token, p_request_id: requestId }, signal));
  if (typeof row.school_id !== "string" || !uuid.test(row.school_id) || typeof row.parent_id !== "string" || !uuid.test(row.parent_id) || !count(row.linked_children) || row.linked_children < 1 || typeof row.replayed !== "boolean") throw invalid();
  return { schoolId: row.school_id, parentId: row.parent_id, linkedChildren: row.linked_children, replayed: row.replayed };
}
