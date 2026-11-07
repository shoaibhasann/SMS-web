import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceContext } from "@/lib/attendance/types";
import { boundMfaSession } from "@/lib/auth/staff-mfa";

export type RosterAdmission = { admissionNumber: string; firstName: string; lastName: string };
export type RosterWriteOptions = { userId: string; signal?: AbortSignal };
export class RosterWriteError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "duplicate" | "unconfirmed" = "unconfirmed") { super(message); this.name = "RosterWriteError"; }
}

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
    p_admission_no: fields.admissionNumber.trim(),
    p_first_name: fields.firstName.trim(),
    p_last_name: fields.lastName.trim(),
  }, options);

  if (error?.code === "23505") throw new RosterWriteError("This admission number is already used in this school.", "duplicate");
  if (error?.code === "42501") throw new RosterWriteError("You cannot admit students for this school.", "access");
  if (error?.code === "22023") throw new RosterWriteError("Check the student details and the current class and section.", "validation");
  if (error || typeof data !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data)) {
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
    p_students: students,
  }, options);

  if (error?.code === "23505") {
    const row = error.message.match(/^Student (\d+) has an admission number already used/);
    throw new RosterWriteError(row ? `Student row ${row[1]} uses an existing admission number. The batch was not saved.`
      : "The batch contains a duplicate admission number. The batch was not saved.", "duplicate");
  }
  if (error?.code === "42501") throw new RosterWriteError("You cannot import students for this school.", "access");
  if (error?.code === "22023") throw new RosterWriteError("Check the student details and current class and section. The batch was not saved.", "validation");
  if (error || !Number.isInteger(data) || data < 1 || data !== students.length) {
    throw new RosterWriteError("The import could not be confirmed. Retry this same preview to check whether it saved.");
  }
  return data as number;
}
