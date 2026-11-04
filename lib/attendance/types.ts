export const attendanceStatuses = [
  "present",
  "absent",
  "late",
  "half_day",
  "leave",
  "holiday",
] as const;

export type AttendanceStatus = (typeof attendanceStatuses)[number];

export const attendanceLabels: Record<AttendanceStatus, string> = {
  present: "Present",
  absent: "Absent",
  late: "Late",
  half_day: "Half Day",
  leave: "Leave",
  holiday: "Holiday",
};

export type AttendanceContext = {
  schoolId: string;
  academicYearId: string;
  classId: string;
  sectionId: string;
};

export type AttendanceStudent = {
  id: string;
  first_name: string;
  middle_name?: string | null;
  last_name?: string | null;
  admission_no: string;
  roll_no?: string | null;
};

export type AttendanceEntry = {
  student_id: string;
  status: AttendanceStatus;
  remarks: string | null;
};

export type AttendanceSnapshot = {
  students: AttendanceStudent[];
  entries: Record<string, AttendanceEntry>;
};

export type AttendanceChange = {
  studentId: string;
  status: AttendanceStatus;
  expected: AttendanceEntry | null;
};

export type AttendanceSaveResult = {
  saved: AttendanceEntry[];
  failures: { studentId: string; message: string }[];
};

export interface AttendanceRepository {
  load(context: AttendanceContext, date: string): Promise<AttendanceSnapshot>;
  save(
    context: AttendanceContext,
    date: string,
    userId: string,
    changes: AttendanceChange[],
  ): Promise<AttendanceSaveResult>;
}

export function attendanceContextKey(context: AttendanceContext): string {
  return JSON.stringify([
    context.schoolId,
    context.academicYearId,
    context.classId,
    context.sectionId,
  ]);
}

export function schoolDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function studentName(student: AttendanceStudent): string {
  return [student.first_name, student.middle_name, student.last_name]
    .filter(Boolean)
    .join(" ");
}
