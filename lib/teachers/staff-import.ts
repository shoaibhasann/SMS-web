import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffImportRow } from "./staff-csv";

type ImportCounts = { teacher_count: number; staff_count: number };
export type StaffImportHistory = ImportCounts & { request_id: string; imported_by_name: string; imported_at: string };

export class StaffImportRejected extends Error {}

export async function importSchoolStaff(client: SupabaseClient, schoolId: string, requestId: string, staff: StaffImportRow[]) {
  const { data, error } = await client.rpc("import_school_staff", {
    p_school_id: schoolId, p_request_id: requestId, p_staff: staff,
  });
  if (error?.code === "42501") throw new StaffImportRejected("You cannot import staff for this school.");
  const row = error?.message.match(/^Staff row (\d+)/)?.[1];
  if (error?.code === "23505") {
    throw new StaffImportRejected(row
      ? `Data row ${row} has an employee ID already used in this file or school. Review the CSV and select it again.`
      : "An employee ID is already used in this school. Review the CSV and select it again.");
  }
  if (error?.code === "22023") {
    throw new StaffImportRejected(row
      ? `Data row ${row} needs a valid employee ID, full name and staff type.`
      : "The import request could not be accepted. Review and select the CSV again.");
  }
  const counts = data as ImportCounts | null;
  if (error || !counts || !Number.isInteger(counts.teacher_count) || !Number.isInteger(counts.staff_count)
    || counts.teacher_count < 0 || counts.staff_count < 0 || counts.teacher_count + counts.staff_count !== staff.length) {
    throw new Error("The import could not be confirmed. Retry this preview to check the same request.");
  }
  return counts;
}

export async function listSchoolStaffImports(client: SupabaseClient, schoolId: string) {
  const { data, error } = await client.rpc("list_school_staff_imports", { p_school_id: schoolId });
  if (error || !Array.isArray(data)) throw new Error("Recent CSV imports could not be loaded.");
  return data as StaffImportHistory[];
}
