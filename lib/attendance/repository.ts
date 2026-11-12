import type { SupabaseClient } from "@supabase/supabase-js";
import { attendanceStatuses } from "./types";
import { loadAttendanceDayContext } from "./day-context";
import { boundMfaSession } from "@/lib/auth/staff-mfa";
import type {
  AttendanceChange,
  AttendanceContext,
  AttendanceEntry,
  AttendanceRepository,
  AttendanceSaveResult,
  AttendanceSnapshot,
  AttendanceStudent,
} from "./types";

const PAGE_SIZE = 200;
const STUDENT_CHUNK_SIZE = 100;
const SAVE_CONCURRENCY = 4;
const ENTRY_COLUMNS = "id,student_id,status,remarks,revision";
const statuses = new Set<string>(attendanceStatuses);

type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
};
type EnrollmentRow = { id: string; student_id: string; roll_no: string | null };
type StudentRow = AttendanceStudent & { status?: string };

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "The attendance request could not be completed. Please retry.";
}

function validateScope(context: AttendanceContext, date: string) {
  if ([context.schoolId, context.academicYearId, context.classId, context.sectionId]
    .some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("A school, academic year, class and section are required for attendance.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("Select a valid attendance date.");
  }
}

function validateEntry(value: unknown): AttendanceEntry {
  const row = value as Partial<AttendanceEntry> | null;
  if (!row || typeof row.student_id !== "string" || !row.student_id ||
    typeof row.status !== "string" || !statuses.has(row.status) ||
    (row.remarks !== null && typeof row.remarks !== "string")) {
    throw new Error("Attendance contains an unsupported or incomplete record. Refresh or contact your administrator.");
  }
  const version = typeof row.id === "string" && Number.isSafeInteger(row.revision)
    ? { id: row.id, revision: row.revision } : {};
  return { ...version, student_id: row.student_id, status: row.status, remarks: row.remarks } as AttendanceEntry;
}

/**
 * Stable ordering plus exact counts prevents a lower server row cap from
 * masquerading as the end of a register. This is not a database snapshot;
 * concurrent roster changes detected through changing counts fail closed.
 */
export async function readPages<T>(
  query: (from: number, to: number) => PromiseLike<PageResult<T>>,
  description: string,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  let expectedCount: number | null = null;
  for (;;) {
    const result = await query(offset, offset + PAGE_SIZE - 1);
    if (result.error) throw new Error(`${description}: ${result.error.message}`);
    if (!Array.isArray(result.data)) throw new Error(`${description}: no readable records were returned.`);
    const count = result.count ?? null;
    if (count !== null) {
      if (expectedCount !== null && expectedCount !== count) {
        throw new Error(`${description}: records changed while loading. Please refresh.`);
      }
      expectedCount = count;
    }
    rows.push(...result.data);
    offset += result.data.length;
    if (expectedCount !== null && offset >= expectedCount) return rows;
    if (!result.data.length) {
      if (expectedCount !== null && offset < expectedCount) {
        throw new Error(`${description}: the full register could not be loaded. Please refresh.`);
      }
      return rows;
    }
    if (expectedCount === null && result.data.length < PAGE_SIZE) return rows;
  }
}

type RegisterOption = { id: string; name: string };
type RegisterSection = RegisterOption & { class_id: string };
type RegisterYear = RegisterOption & { start_date: string; end_date: string; is_current: boolean };

export function loadAdminAttendanceAccess(client: SupabaseClient, principal = false) {
  return loadSchoolManagementAccess(client, "attendance", [principal ? "principal" : "school_admin"]);
}

export async function loadSchoolManagementAccess(
  client: SupabaseClient,
  task: string,
  schoolRoles: readonly string[],
) {
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new Error(`Sign in again to manage ${task}.`);

  const roles = await readPages<{ role: string; school_id: string | null }>((from, to) => client
    .from("user_roles").select("role,school_id", { count: "exact" })
    .eq("user_id", user.id).order("id").range(from, to), "School permissions could not be loaded");
  const globalAdmin = roles.some((row) => row.role === "super_admin" && row.school_id === null);
  const schoolIds = [...new Set(roles.flatMap((row) =>
    schoolRoles.includes(row.role) && row.school_id ? [row.school_id] : [],
  ))];
  if (!globalAdmin && !schoolIds.length) throw new Error(`A school administrator role is required to manage ${task}.`);

  const schools = await readPages<RegisterOption>((from, to) => {
    const query = client.from("schools").select("id,name", { count: "exact" }).order("name").order("id");
    return (globalAdmin ? query : query.in("id", schoolIds)).range(from, to);
  }, "Schools could not be loaded");
  if (!schools.length) throw new Error("No authorized schools were found.");
  const schoolAdminIds = roles.flatMap(({ role, school_id }) => role === "school_admin" && school_id ? [school_id] : []);
  return { userId: user.id, schools, schoolAdminIds };
}

export async function loadAdminAttendanceSetup(
  client: SupabaseClient,
  schoolId: string,
  options: { activeClassesOnly?: boolean; includePastYears?: boolean } = {},
) {
  const [years, classes, sections] = await Promise.all([
    readPages<RegisterYear>((from, to) => {
      const query = client.from("academic_years")
        .select("id,name,start_date,end_date,is_current", { count: "exact" }).eq("school_id", schoolId);
      return (options.includePastYears ? query : query.eq("is_current", true))
        .order("start_date", { ascending: false }).order("id").range(from, to);
    }, "Academic years could not be loaded"),
    readPages<RegisterOption>((from, to) => {
      const query = client.from("classes")
        .select("id,name", { count: "exact" }).eq("school_id", schoolId).order("name").order("id");
      return (options.activeClassesOnly ? query.eq("is_active", true) : query).range(from, to);
    }, "Classes could not be loaded"),
    readPages<RegisterSection>((from, to) => client.from("sections")
      .select("id,name,class_id", { count: "exact" }).eq("school_id", schoolId)
      .order("name").order("id").range(from, to), "Sections could not be loaded"),
  ]);
  const currentYears = years.filter((year) => year.is_current);
  if (currentYears.length !== 1) throw new Error("Set exactly one current academic year for this school to open its register.");
  return { year: currentYears[0], years, classes, sections };
}

export async function loadEnrolledStudents(
  client: SupabaseClient,
  context: AttendanceContext,
  options: { activeStudentsOnly?: boolean; enrollmentRollOnly?: boolean } = {},
) {
  const enrollments = await readPages<EnrollmentRow>((from, to) => client
    .from("enrollments")
    .select("id,student_id,roll_no", { count: "exact" })
    .eq("academic_year_id", context.academicYearId)
    .eq("class_id", context.classId)
    .eq("section_id", context.sectionId)
    .eq("status", "active")
    .order("id", { ascending: true })
    .range(from, to), "Student enrollments could not be loaded");

  const enrollmentByStudent = new Map<string, EnrollmentRow>();
  for (const enrollment of enrollments) {
    if (!enrollment.student_id || enrollmentByStudent.has(enrollment.student_id)) {
      throw new Error("The class roster contains an incomplete or duplicate enrollment. Contact your administrator.");
    }
    enrollmentByStudent.set(enrollment.student_id, enrollment);
  }
  const studentIds = [...enrollmentByStudent.keys()];
  const studentById = new Map<string, StudentRow>();
  for (let offset = 0; offset < studentIds.length; offset += STUDENT_CHUNK_SIZE) {
    const ids = studentIds.slice(offset, offset + STUDENT_CHUNK_SIZE);
    const studentRows = await readPages<StudentRow>((from, to) => client
      .from("students")
      .select("id,first_name,middle_name,last_name,admission_no,roll_no,status", { count: "exact" })
      .eq("school_id", context.schoolId)
      .in("id", ids)
      .order("id", { ascending: true })
      .range(from, to), "Student details could not be loaded");
    for (const row of studentRows) {
      if (!ids.includes(row.id) || studentById.has(row.id) ||
        typeof row.first_name !== "string" || typeof row.admission_no !== "string") {
        throw new Error("The class roster contains an unreadable student. Contact your administrator.");
      }
      studentById.set(row.id, row);
    }
  }
  if (studentIds.some((id) => !studentById.has(id))) {
    throw new Error("Some enrolled students could not be accessed. Refresh or contact your administrator.");
  }

  const students = studentIds.flatMap((id) => {
    const { status, ...student } = studentById.get(id)!;
    if (options.activeStudentsOnly && status !== "active") return [];
    const enrollment = enrollmentByStudent.get(id)!;
    const rollNumber = enrollment.roll_no ?? (options.enrollmentRollOnly ? null : student.roll_no ?? null);
    return [{ ...student, enrollment_id: enrollment.id, roll_no: rollNumber }];
  });
  return students.sort(compareRosterStudents);
}

function compareRosterStudents(left: AttendanceStudent, right: AttendanceStudent) {
  return String(left.roll_no ?? "").localeCompare(
    String(right.roll_no ?? ""), undefined, { numeric: true, sensitivity: "base" },
  ) || left.first_name.localeCompare(right.first_name) || left.id.localeCompare(right.id);
}

/**
 * The daily guard and RLS enforce register scope. The loaded revision detects
 * intervening writes, and the existing student/date key prevents duplicate
 * new marks. Today's batch remains a per-pupil save.
 */
export function createAttendanceRepository(client: SupabaseClient, expectedUserId: string): AttendanceRepository {
  return {
    async load(context: AttendanceContext, date: string): Promise<AttendanceSnapshot> {
      validateScope(context, date);
      const [students, attendanceRows, day] = await Promise.all([
        readPages<AttendanceStudent>((from, to) => client.rpc("list_attendance_register_students", {
          p_school_id: context.schoolId,
          p_year_id: context.academicYearId,
          p_class_id: context.classId,
          p_section_id: context.sectionId,
          p_day: date,
        }, { count: "exact" }).order("id").range(from, to), "Student enrollments could not be loaded"),
        readPages<AttendanceEntry>((from, to) => client
          .from("attendance")
          .select(ENTRY_COLUMNS, { count: "exact" })
          .eq("school_id", context.schoolId)
          .eq("academic_year_id", context.academicYearId)
          .eq("section_id", context.sectionId)
          .eq("attendance_date", date)
          .order("student_id", { ascending: true })
          .range(from, to), "Saved attendance could not be loaded"),
        loadAttendanceDayContext(client, expectedUserId, context, date),
      ]);
      const studentIds = new Set<string>();
      for (const student of students) {
        if (!student || typeof student.id !== "string" || !student.id || studentIds.has(student.id) ||
          typeof student.first_name !== "string" || typeof student.admission_no !== "string") {
          throw new Error("The class roster contains an incomplete or duplicate student. Contact your administrator.");
        }
        studentIds.add(student.id);
      }
      const entries: Record<string, AttendanceEntry> = {};
      for (const value of attendanceRows) {
        const entry = validateEntry(value);
        if (Object.hasOwn(entries, entry.student_id)) {
          throw new Error("The register contains duplicate attendance records. Contact your administrator.");
        }
        entries[entry.student_id] = entry;
      }

      return { students: students.sort(compareRosterStudents), entries, day };
    },

    async save(
      context: AttendanceContext,
      date: string,
      userId: string,
      changes: AttendanceChange[],
    ): Promise<AttendanceSaveResult> {
      validateScope(context, date);
      if (!userId.trim() || userId !== expectedUserId) throw new Error("Sign in again before saving attendance.");
      const seen = new Set<string>();
      // Validate the entire request before any writes, so malformed input cannot
      // produce a partly applied operation.
      for (const change of changes) {
        if (!change.studentId || seen.has(change.studentId)) {
          throw new Error("A student can only appear once in an attendance save.");
        }
        seen.add(change.studentId);
        if (!statuses.has(change.status)) throw new Error("Select a supported attendance status before saving.");
        if (change.expected !== null) {
          const expected = validateEntry(change.expected);
          if (expected.student_id !== change.studentId) {
            throw new Error("The saved attendance does not match this student. Refresh before retrying.");
          }
        }
      }
      if (!changes.length) return { saved: [], failures: [] };

      // Catch a pupil moved/withdrawn since the editor loaded. This preflight is
      // not atomic with the following writes; deployed RLS must still enforce
      // enrollment/tenant permissions at write time.
      const eligible = new Set<string>();
      const studentIds = [...seen];
      for (let offset = 0; offset < studentIds.length; offset += STUDENT_CHUNK_SIZE) {
        const ids = studentIds.slice(offset, offset + STUDENT_CHUNK_SIZE);
        const enrollments = await readPages<Pick<EnrollmentRow, "student_id">>((from, to) => client
          .from("enrollments")
          .select("student_id", { count: "exact" })
          .eq("academic_year_id", context.academicYearId)
          .eq("class_id", context.classId)
          .eq("section_id", context.sectionId)
          .eq("status", "active")
          .in("student_id", ids)
          .order("id", { ascending: true })
          .range(from, to), "Student enrollment could not be verified");
        const enrolledIds = [...new Set(enrollments.map((row) => row.student_id))];
        if (!enrolledIds.length) continue;
        const students = await readPages<Pick<StudentRow, "id">>((from, to) => client
          .from("students")
          .select("id", { count: "exact" })
          .eq("school_id", context.schoolId)
          .in("id", enrolledIds)
          .order("id", { ascending: true })
          .range(from, to), "Student school access could not be verified");
        for (const student of students) eligible.add(student.id);
      }
      const results: ({ saved: AttendanceEntry } | AttendanceSaveResult["failures"][number])[] = new Array(changes.length);
      let nextIndex = 0;

      async function saveOne(change: AttendanceChange): Promise<AttendanceEntry> {
        if (!eligible.has(change.studentId)) {
          throw new Error("This student is no longer actively enrolled in this class or cannot be accessed. Refresh before retrying.");
        }
        const expected = change.expected === null ? null : validateEntry(change.expected);
        const next: AttendanceEntry = {
          student_id: change.studentId,
          status: change.status,
          remarks: expected?.remarks ?? null,
        };
        if (expected?.status === change.status) return expected;

        let result;
        if (expected) {
          let query = client.from("attendance")
            .update({ status: next.status, marked_by: userId })
            .eq("school_id", context.schoolId)
            .eq("academic_year_id", context.academicYearId)
            .eq("section_id", context.sectionId)
            .eq("student_id", change.studentId)
            .eq("attendance_date", date)
            .eq("status", expected.status);
          query = expected.remarks === null ? query.is("remarks", null) : query.eq("remarks", expected.remarks);
          if (expected.id && expected.revision !== undefined) {
            query = query.eq("id", expected.id).eq("revision", expected.revision);
          }
          result = await query.select(ENTRY_COLUMNS);
        } else {
          result = await client.from("attendance").insert({
            school_id: context.schoolId,
            academic_year_id: context.academicYearId,
            section_id: context.sectionId,
            student_id: change.studentId,
            attendance_date: date,
            status: next.status,
            remarks: null,
            marked_by: userId,
          }).select(ENTRY_COLUMNS);
        }
        if (result.error) {
          if (result.error.code === "23505") {
            throw new Error("Attendance was recorded elsewhere. Refresh before retrying this student.");
          }
          throw result.error;
        }
        if (!Array.isArray(result.data) || result.data.length !== 1) {
          throw new Error("Attendance changed elsewhere or is no longer accessible. Refresh before retrying this student.");
        }
        const saved = validateEntry(result.data[0]);
        if (saved.student_id !== change.studentId || saved.status !== change.status) {
          throw new Error("The saved attendance could not be verified. Refresh before retrying this student.");
        }
        return saved;
      }

      async function worker() {
        for (;;) {
          const index = nextIndex++;
          if (index >= changes.length) return;
          const change = changes[index];
          try {
            results[index] = { saved: await saveOne(change) };
          } catch (error) {
            results[index] = { studentId: change.studentId, message: messageOf(error), code: (error as { code?: string } | null)?.code };
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, changes.length) }, worker));
      return {
        saved: results.flatMap((result) => "saved" in result ? [result.saved] : []),
        failures: results.flatMap((result) => "saved" in result ? [] : [result]),
      };
    },

    async requestCorrection(context, date, change, reason, requestId) {
      validateScope(context, date);
      if (change.expected && (!change.expected.id || change.expected.revision === undefined)) {
        throw new Error("Reload this attendance register before submitting a correction.");
      }
      const session = await boundMfaSession(client, expectedUserId, new AbortController().signal);
      if (!session) throw new Error("Sign in again before requesting an attendance correction.");
      const { data, error } = await client.rpc("request_attendance_correction", {
        p_school_id: context.schoolId,
        p_year_id: context.academicYearId,
        p_section_id: context.sectionId,
        p_student_id: change.studentId,
        p_day: date,
        p_expected_id: change.expected?.id ?? null,
        p_expected_revision: change.expected?.revision ?? null,
        p_status: change.status,
        p_reason: reason.trim(),
        p_request_id: requestId,
      }).setHeader("Authorization", `Bearer ${session.access_token}`);
      if (error) {
        const conflict = error.code === "PT409" || error.code === "40001";
        throw Object.assign(new Error(conflict
          ? "Attendance changed before the correction could be requested. Reload the register and check the latest mark before requesting again."
          : messageOf(error)), { code: error.code });
      }
      if (data !== requestId) throw new Error("The correction could not be confirmed. Retry the same request.");
    },
  };
}
