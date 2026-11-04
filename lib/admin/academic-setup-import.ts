import type { SupabaseClient } from "@supabase/supabase-js";
import type { AcademicImportKind, AcademicImportRecord } from "./academic-setup-csv";

export type AcademicImportHistory = { request_id: string; record_count: number; imported_by_name: string; imported_at: string };
export class AcademicImportRejected extends Error {}

export async function importAcademicSetupRecords(
  client: SupabaseClient, schoolId: string, kind: AcademicImportKind, requestId: string, records: AcademicImportRecord[],
) {
  const { data, error } = await client.rpc("import_academic_setup_records", {
    p_school_id: schoolId, p_kind: kind, p_request_id: requestId, p_records: records,
  });
  if (error?.code === "42501") throw new AcademicImportRejected("You cannot import academic records for this school.");
  const row = error?.message.match(/^Academic row (\d+)/)?.[1];
  if (error?.code === "23505") {
    const duplicate = error.message.includes("subject code") ? "subject code" : "name";
    throw new AcademicImportRejected(row
      ? `Data row ${row} has a duplicate ${duplicate}. Refresh records and select a corrected CSV.`
      : "The import has a duplicate record. Refresh records and select a corrected CSV.");
  }
  if (error?.code === "22023") {
    throw new AcademicImportRejected(row
      ? `Data row ${row} is invalid or its class changed. Refresh records and select a corrected CSV.`
      : "The import request could not be accepted. Review and select the CSV again.");
  }
  if (error || data !== records.length) {
    throw new Error("The import could not be confirmed. Retry this preview to check the same request.");
  }
  return data as number;
}

export async function listAcademicSetupImports(client: SupabaseClient, schoolId: string, kind: AcademicImportKind) {
  const { data, error } = await client.rpc("list_academic_setup_imports", { p_school_id: schoolId, p_kind: kind });
  if (error || !Array.isArray(data)) throw new Error("Recent CSV imports could not be loaded.");
  return data as AcademicImportHistory[];
}
