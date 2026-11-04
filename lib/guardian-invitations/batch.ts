import type { SupabaseClient } from "@supabase/supabase-js";
import { isIssuedInvitation, type IssuedInvitation } from "@/lib/invitations/model";
import type { GuardianCsvRow } from "./guardian-csv";

type SourceRow = Pick<GuardianCsvRow, "rowNumber" | "admissionNumber" | "email">;

export type GuardianImportRow = SourceRow & {
  studentId: string | null;
  studentName: string | null;
  error: string | null;
};
export type GuardianImportMatch = GuardianImportRow & { studentId: string; error: null };

export type GuardianBatchInvitation = IssuedInvitation & {
  rowNumber: number;
  admissionNumber: string;
  email: string;
  studentName: string;
};

type MatchPayload = {
  row_number?: unknown;
  admission_no?: unknown;
  email?: unknown;
  student_id?: unknown;
  student_name?: unknown;
  error?: unknown;
};

function matchesSource(row: MatchPayload | null | undefined, expected: SourceRow) {
  return row?.row_number === expected.rowNumber && row.admission_no === expected.admissionNumber && row.email === expected.email;
}

function invitationPermissionError(): never {
  throw new Error("You do not have permission to import guardian invitations for this school.");
}

export async function previewGuardianInvitationImport(
  client: SupabaseClient, schoolId: string, rows: readonly SourceRow[],
): Promise<GuardianImportRow[]> {
  const { data, error } = await client.rpc("preview_guardian_invitation_import", {
    p_school_id: schoolId,
    p_rows: rows.map(({ admissionNumber, email }) => ({ admissionNumber, email })),
  });
  if (error?.code === "42501") invitationPermissionError();
  if (error || !Array.isArray(data) || data.length !== rows.length) {
    throw new Error("The student matches could not be checked. Try previewing the file again.");
  }

  return rows.map((expected, index) => {
    const row = data[index] as MatchPayload | null;
    if (!row || !matchesSource(row, expected) ||
      (row.error !== null && typeof row.error !== "string") ||
      (row.student_id !== null && typeof row.student_id !== "string") ||
      (row.student_name !== null && typeof row.student_name !== "string") ||
      (row.error === null && (!row.student_id || !row.student_name))) {
      throw new Error("The student matches could not be checked. Try previewing the file again.");
    }
    return {
      ...expected,
      studentId: row.student_id,
      studentName: row.student_name,
      error: row.error,
    };
  });
}

export function makeGuardianImportRequest() {
  const deliveryKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { requestId: crypto.randomUUID(), deliveryKey };
}

export async function importGuardianInvitations(
  client: SupabaseClient,
  schoolId: string,
  request: ReturnType<typeof makeGuardianImportRequest>,
  rows: readonly GuardianImportMatch[],
): Promise<GuardianBatchInvitation[]> {
  const { data, error } = await client.rpc("import_guardian_invitations", {
    p_school_id: schoolId,
    p_request_id: request.requestId,
    p_delivery_key: request.deliveryKey,
    p_rows: rows.map(({ admissionNumber, email, studentId }) => ({ admissionNumber, email, studentId })),
  });
  if (error?.code === "42501") invitationPermissionError();
  if (error?.code === "22023") {
    const rowError = /^Guardian import row \d+(?::| changed since preview\.)/.test(error.message);
    throw new Error(rowError
      ? error.message
      : "The import preview is no longer valid. Check the roster and preview the file again.");
  }
  if (error?.code === "23505") throw new Error("This import request changed. Preview the file again before creating invitations.");
  if (error?.code === "55000") {
    throw new Error("The import finished, and at least one link is no longer available. Review the individual invitation histories.");
  }
  if (error || data?.request_id !== request.requestId || !Array.isArray(data?.invitations) || data.invitations.length !== rows.length) {
    throw new Error("The import could not be confirmed. Retry from this same preview to recover the links.");
  }

  return rows.map((expected, index) => {
    const invitation = data.invitations[index] as MatchPayload | null;
    const studentName = invitation?.student_name;
    if (!invitation || !matchesSource(invitation, expected) || invitation.student_id !== expected.studentId ||
      typeof studentName !== "string" || !isIssuedInvitation(invitation)) {
      throw new Error("The import could not be confirmed. Retry from this same preview to recover the links.");
    }
    return {
      id: invitation.id,
      token: invitation.token,
      expires_at: invitation.expires_at,
      rowNumber: expected.rowNumber,
      admissionNumber: expected.admissionNumber,
      email: expected.email,
      studentName,
    };
  });
}
