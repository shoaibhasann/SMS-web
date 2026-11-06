import type { SupabaseClient } from "@supabase/supabase-js";
import { attendanceStatuses, type AttendanceStatus } from "@/lib/attendance/types";

export type AttendanceCounts = Record<AttendanceStatus, number>;

export async function loadSchoolAttendanceCounts(client: SupabaseClient, schoolId: string, date: string) {
  const counts = await Promise.all([null, ...attendanceStatuses].map(async (status) => {
    const query = client.from("attendance").select("id", { count: "exact", head: true })
      .eq("school_id", schoolId).eq("attendance_date", date);
    const { count, error } = await (status ? query.eq("status", status) : query);
    if (error) throw error;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Attendance count is unavailable.");
    return count;
  }));
  const [total, ...values] = counts;
  // Separate counts may cross an attendance save; never present an inconsistent breakdown.
  if (values.reduce((sum, count) => sum + count, 0) !== total) throw new Error("Attendance changed. Refresh the dashboard.");
  return { total, statuses: Object.fromEntries(attendanceStatuses.map((status, index) => [status, values[index]])) as AttendanceCounts };
}
