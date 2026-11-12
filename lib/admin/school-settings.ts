import type { SupabaseClient } from "@supabase/supabase-js";

export const schoolBoards = ["CBSE", "UP_BOARD"] as const;
export type SchoolBoard = (typeof schoolBoards)[number];
export type SchoolDetails = {
  name: string; board: SchoolBoard | null; affiliation_no: string | null; address: string | null;
  city: string | null; state: string | null; pincode: string | null; phone: string | null;
  email: string | null; website: string | null;
};
export type SchoolSettings = {
  school: SchoolDetails & { id: string; code: string | null; timezone: string; revision: number };
  can_edit: boolean;
  setup: {
    school_day: string; current_year: null | { id: string; name: string; start_date: string; end_date: string };
    current_year_count: number; active_classes: number; sections: number; classes_without_sections: number;
    active_subjects: number; teachers: number; linked_teachers: number; teaching_assignments: number;
    sections_without_class_teacher: number; enrolled_students: number; invalid_enrollments: number;
    linked_students: number; pending_guardian_invitations: number; today_attendance: number;
  };
  history: { id: string; revision: number; changed_at: string; actor_name: string | null; changed_fields: string[] }[];
};
export type SchoolSettingsIntent = {
  schoolId: string; expectedRevision: number; requestId: string; details: SchoolDetails; reason: string;
};
export class SchoolSettingsError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "conflict" | "unconfirmed" = "unconfirmed") {
    super(message); this.name = "SchoolSettingsError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controls = /[\u0000-\u001f\u007f]/;
const addressControls = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const revision = (value: unknown): value is number => count(value) && value <= 2147483647;
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum && !controls.test(value);
const optional = (value: unknown, maximum: number) => value === null || text(value, maximum);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const detailKeys = ["name", "board", "affiliation_no", "address", "city", "state", "pincode", "phone", "email", "website"] as const;
const countKeys = ["current_year_count", "active_classes", "sections", "classes_without_sections", "active_subjects", "teachers", "linked_teachers", "teaching_assignments", "sections_without_class_teacher", "enrolled_students", "invalid_enrollments", "linked_students", "pending_guardian_invitations", "today_attendance"] as const;

export function schoolDetails(record: SchoolDetails): SchoolDetails {
  const details = Object.fromEntries(detailKeys.map((key) => [key, typeof record[key] === "string" ? record[key].trim() || null : record[key]])) as SchoolDetails;
  details.name = record.name.trim();
  if (details.email) details.email = details.email.toLowerCase();
  if (details.address) details.address = details.address.replace(/\r\n?/g, "\n");
  return details;
}

export function validateSchoolDetails(input: SchoolDetails): string | null {
  if (!text(input.name, 160) || input.name.trim().length < 2) return "Use 2–160 characters for the school name.";
  if (input.board !== null && !schoolBoards.includes(input.board)) return "Choose a supported board or leave it unconfigured.";
  if (input.address !== null && (typeof input.address !== "string" || input.address.length > 1000 || addressControls.test(input.address))) return "Use up to 1,000 characters for the school address.";
  for (const [key, maximum] of [["affiliation_no", 100], ["city", 100], ["state", 100], ["phone", 24], ["email", 254], ["website", 300]] as const) {
    if (!optional(input[key], maximum)) return `Check the ${key.replaceAll("_", " ")} field and its length.`;
  }
  if (input.pincode !== null && !/^\d{6}$/.test(input.pincode)) return "Use a six-digit PIN code or leave it empty.";
  if (input.phone !== null && (!/^(\+[0-9]|[0-9(])[0-9 ()-]*$/.test(input.phone) || input.phone.replace(/\D/g, "").length < 7 || input.phone.replace(/\D/g, "").length > 15)) return "Use a phone number with 7–15 digits, with optional spaces, parentheses or hyphens.";
  if (input.email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return "Enter a valid school email or leave it empty.";
  if (input.website !== null) {
    try {
      const url = new URL(input.website);
      const authority = /^https:\/\/([^/?#]+)/.exec(input.website)?.[1] ?? "";
      if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$/.test(authority)
        || url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port === "0" || /[\\\s]/.test(input.website)) throw new Error();
    } catch { return "Use an HTTPS website without a username, password or spaces."; }
  }
  return null;
}

export function parseSchoolSettings(value: unknown, schoolId: string): SchoolSettings {
  const row = object(value), school = object(row.school), setup = object(row.setup), year = setup.current_year === null ? null : object(setup.current_year);
  const valid = uuid.test(schoolId) && school.id === schoolId && text(school.name, 160) && school.name.trim().length >= 2
    && optional(school.code, 100) && text(school.timezone, 100) && school.timezone.length > 0 && revision(school.revision)
    && (school.board === null || schoolBoards.includes(school.board as SchoolBoard))
    && optional(school.affiliation_no, 100) && (school.address === null || typeof school.address === "string" && school.address.length <= 1000 && !addressControls.test(school.address)) && optional(school.city, 100) && optional(school.state, 100)
    && optional(school.pincode, 20) && optional(school.phone, 24) && optional(school.email, 254) && optional(school.website, 300)
    && typeof row.can_edit === "boolean" && date(setup.school_day) && countKeys.every((key) => count(setup[key]))
    && (year === null ? setup.current_year_count !== 1 : setup.current_year_count === 1 && typeof year.id === "string" && uuid.test(year.id)
      && text(year.name, 160) && date(year.start_date) && date(year.end_date) && year.start_date <= year.end_date)
    && (setup.linked_teachers as number) <= (setup.teachers as number) && (setup.linked_students as number) <= (setup.enrolled_students as number)
    && (setup.classes_without_sections as number) <= (setup.active_classes as number) && (setup.sections_without_class_teacher as number) <= (setup.sections as number)
    && Array.isArray(row.history) && row.history.length <= 10 && new Set(row.history.map((item) => object(item).id)).size === row.history.length && row.history.every((item, index) => {
      const event = object(item);
      return typeof event.id === "string" && uuid.test(event.id) && revision(event.revision) && event.revision > 0 && event.revision <= (school.revision as number)
        && (index === 0 || event.revision < (object((row.history as unknown[])[index - 1]).revision as number))
        && typeof event.changed_at === "string" && event.changed_at.length <= 50 && Number.isFinite(Date.parse(event.changed_at))
        && optional(event.actor_name, 200) && Array.isArray(event.changed_fields) && event.changed_fields.length > 0 && event.changed_fields.length <= detailKeys.length && new Set(event.changed_fields).size === event.changed_fields.length
        && event.changed_fields.every((field) => typeof field === "string" && detailKeys.includes(field as typeof detailKeys[number]));
    });
  if (!valid) throw new SchoolSettingsError("School settings could not be verified. Reload to try again.");
  return value as SchoolSettings;
}

function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Request cancelled.", "AbortError"); }
async function boundToken(client: SupabaseClient, userId: string, signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  const { data, error } = await client.auth.getSession();
  const session = data.session;
  if (error || !session || session.user.id !== userId || !session.access_token) throw new SchoolSettingsError("Your sign-in changed. Reopen school settings.", "access");
  const verified = await client.auth.getUser(session.access_token);
  cancelled(signal);
  if (verified.error || verified.data.user?.id !== userId || verified.data.user.is_anonymous) throw new SchoolSettingsError("Your sign-in changed. Reopen school settings.", "access");
  return session.access_token;
}
function rpcError(error: { code?: string } | null, reading = false) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new SchoolSettingsError("Your current account cannot manage settings for this school. Reopen settings to check access.", "access");
  if (["40001", "PT409"].includes(error.code ?? "")) throw new SchoolSettingsError("School settings changed elsewhere. Your draft is kept; reload saved settings before trying again.", "conflict");
  if (error.code === "22023") throw new SchoolSettingsError("The save was rejected. Check the fields and change reason, then try again.", "validation");
  throw new SchoolSettingsError(reading ? "School settings could not be loaded. Reload to try again." : "The save could not be confirmed. Retry the same save to check its outcome.");
}

export async function loadSchoolSettings(client: SupabaseClient, userId: string, schoolId: string, signal?: AbortSignal): Promise<SchoolSettings> {
  if (!uuid.test(schoolId)) throw new SchoolSettingsError("Choose an authorized school.", "validation");
  const token = await boundToken(client, userId, signal);
  const { data, error } = await client.rpc("get_school_settings", { p_school_id: schoolId })
    .setHeader("Authorization", `Bearer ${token}`).abortSignal(signal ?? new AbortController().signal);
  cancelled(signal);
  rpcError(error, true);
  return parseSchoolSettings(data, schoolId);
}

export async function saveSchoolSettings(client: SupabaseClient, userId: string, intent: SchoolSettingsIntent, signal?: AbortSignal) {
  const invalid = validateSchoolDetails(intent.details);
  if (invalid || !uuid.test(intent.schoolId) || !uuid.test(intent.requestId) || !revision(intent.expectedRevision)
    || intent.reason.trim().length < 5 || intent.reason.trim().length > 300 || controls.test(intent.reason)) {
    throw new SchoolSettingsError(invalid ?? "Use a 5–300 character change reason and a valid saved revision.", "validation");
  }
  const token = await boundToken(client, userId, signal);
  // Pin this request to its verified token; shared browser Auth may change while fetch prepares the request.
  const { data, error } = await client.rpc("save_school_settings", {
    p_school_id: intent.schoolId, p_expected_revision: intent.expectedRevision, p_request_id: intent.requestId,
    p_details: intent.details, p_reason: intent.reason.trim(),
  }).setHeader("Authorization", `Bearer ${token}`).abortSignal(signal ?? new AbortController().signal);
  cancelled(signal);
  rpcError(error);
  const result = object(data);
  if (!revision(result.revision) || typeof result.changed !== "boolean" || typeof result.replayed !== "boolean"
    || result.revision !== intent.expectedRevision + (result.changed ? 1 : 0)) {
    throw new SchoolSettingsError("The save could not be confirmed. Retry the same save to check its outcome.");
  }
  return { revision: result.revision, changed: result.changed, replayed: result.replayed };
}
