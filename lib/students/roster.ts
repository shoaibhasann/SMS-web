import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceContext } from "@/lib/attendance/types";
import { boundMfaSession } from "@/lib/auth/staff-mfa";

// DOB (YYYY-MM-DD) and registered mobile are optional, but Student activation needs both.
export type RosterAdmission = { admissionNumber: string; firstName: string; lastName: string; dateOfBirth?: string; registeredMobile?: string };
export type RosterStudentDetails = { firstName: string; middleName: string; lastName: string; dateOfBirth: string; registeredMobile: string };
export type RosterWriteOptions = { userId: string; signal?: AbortSignal };
// Names pasted from phone contacts often carry invisible bidi/isolate marks the database rejects.
export const plainRosterText = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, "").trim();
export class RosterWriteError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "duplicate" | "unconfirmed" = "unconfirmed") { super(message); this.name = "RosterWriteError"; }
}

// Only filled values are sent, so a plain admission keeps the original RPC arguments.
const contactArgs = (fields: { dateOfBirth?: string; registeredMobile?: string }) => ({
  ...(fields.dateOfBirth ? { p_dob: fields.dateOfBirth } : {}),
  ...(fields.registeredMobile?.trim() ? { p_registered_mobile: fields.registeredMobile.trim() } : {}),
});
const contactError = (message: string | undefined) =>
  message === "Enter a valid date of birth." || message === "Enter a valid 10-digit mobile number." ? message : undefined;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rosterWrite(client: SupabaseClient, name: string, args: Record<string, unknown>, options: RosterWriteOptions) {
  if (!options.userId) throw new RosterWriteError("Sign in again to manage admissions.", "access");
  let session: Session | null;
  try { session = await boundMfaSession(client, options.userId, options.signal); }
  catch (error) {
    if (options.signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
    throw new RosterWriteError(error instanceof Error ? error.message : "Sign in again to manage admissions.", "access");
  }
  if (!session) throw new RosterWriteError("Sign in again to manage admissions.", "access");
  try {
    const result = await client.rpc(name, args).setHeader("Authorization", `Bearer ${session.access_token}`)
      .abortSignal(options.signal ?? new AbortController().signal);
    if (options.signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
    return result;
  } catch {
    if (options.signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
    throw new RosterWriteError("The save could not be confirmed. Reload the roster, or retry the same import preview, before starting another save.");
  }
}

export async function admitRosterStudent(
  client: SupabaseClient,
  context: AttendanceContext,
  fields: RosterAdmission,
  options: RosterWriteOptions,
) {
  const { data, error } = await rosterWrite(client, "admit_roster_student", {
    p_school_id: context.schoolId,
    p_academic_year_id: context.academicYearId,
    p_class_id: context.classId,
    p_section_id: context.sectionId,
    p_admission_no: plainRosterText(fields.admissionNumber),
    p_first_name: plainRosterText(fields.firstName),
    p_last_name: plainRosterText(fields.lastName),
    ...contactArgs(fields),
  }, options);

  if (error?.code === "23505") throw new RosterWriteError("This admission number is already used in this school.", "duplicate");
  if (error?.code === "42501") throw new RosterWriteError("You cannot admit students for this school.", "access");
  if (error?.code === "22023") throw new RosterWriteError(contactError(error.message) ?? "Check the student details and the current class and section.", "validation");
  if (error || typeof data !== "string" || !uuidPattern.test(data)) {
    throw new RosterWriteError("Admission could not be confirmed. Reload the roster before retrying.");
  }
  return data;
}

export async function importRosterStudents(
  client: SupabaseClient,
  context: AttendanceContext,
  requestId: string,
  students: RosterAdmission[],
  options: RosterWriteOptions,
) {
  const { data, error } = await rosterWrite(client, "import_roster_students", {
    p_school_id: context.schoolId,
    p_academic_year_id: context.academicYearId,
    p_class_id: context.classId,
    p_section_id: context.sectionId,
    p_request_id: requestId,
    p_students: students.map(student => ({
      admissionNumber: plainRosterText(student.admissionNumber), firstName: plainRosterText(student.firstName), lastName: plainRosterText(student.lastName),
      ...(student.dateOfBirth ? { dateOfBirth: student.dateOfBirth } : {}),
      ...(student.registeredMobile ? { registeredMobile: student.registeredMobile } : {}),
    })),
  }, options);

  if (error?.code === "23505") {
    const row = error.message.match(/^Student (\d+) has an admission number already used/);
    throw new RosterWriteError(row ? `Student row ${row[1]} uses an existing admission number. The batch was not saved.`
      : "The batch contains a duplicate admission number. The batch was not saved.", "duplicate");
  }
  if (error?.code === "42501") throw new RosterWriteError("You cannot import students for this school.", "access");
  if (error?.code === "22023") {
    const contact = contactError(error.message); // the CSV preview checks these per row; this covers a stale preview
    throw new RosterWriteError(`${contact ?? "Check the student details and current class and section."} The batch was not saved.`, "validation");
  }
  if (error || !Number.isInteger(data) || data < 1 || data !== students.length) {
    throw new RosterWriteError("The import could not be confirmed. Retry this same preview to check whether it saved.");
  }
  return data as number;
}

export type RosterImportHistory = { request_id: string; student_count: number; imported_by_name: string | null; imported_at: string | null };

export async function listRosterImports(client: SupabaseClient, schoolId: string) {
  const { data, error } = await client.rpc("list_roster_imports", { p_school_id: schoolId });
  if (error || !Array.isArray(data)) throw new Error("Recent CSV imports could not be loaded.");
  return data as RosterImportHistory[];
}

export async function loadRosterStudentDetails(client: SupabaseClient, schoolId: string, studentId: string): Promise<RosterStudentDetails> {
  const { data, error } = await client.from("students").select("id,first_name,middle_name,last_name,dob,registered_mobile")
    .eq("school_id", schoolId).eq("id", studentId).maybeSingle();
  if (error || !data || data.id !== studentId) throw new Error("The pupil details could not be loaded. Reload the roster and try again.");
  return { firstName: data.first_name ?? "", middleName: data.middle_name ?? "", lastName: data.last_name ?? "",
    dateOfBirth: data.dob ?? "", registeredMobile: data.registered_mobile ?? "" };
}

export async function updateRosterStudentDetails(
  client: SupabaseClient, schoolId: string, studentId: string, fields: RosterStudentDetails, options: RosterWriteOptions,
) {
  const { data, error } = await rosterWrite(client, "update_roster_student_details", {
    p_school_id: schoolId, p_student_id: studentId,
    p_first_name: plainRosterText(fields.firstName), p_middle_name: plainRosterText(fields.middleName) || null,
    p_last_name: plainRosterText(fields.lastName) || null,
    p_dob: fields.dateOfBirth || null, p_registered_mobile: fields.registeredMobile.trim() || null,
  }, options);
  if (error?.code === "42501") throw new RosterWriteError("You cannot edit students for this school.", "access");
  if (error?.code === "22023") throw new RosterWriteError(contactError(error.message) ?? "Check the pupil name and reload the roster.", "validation");
  if (error || data !== studentId) throw new RosterWriteError("The pupil details could not be confirmed. Reload the roster before retrying.");
}
