"use client";

import Link from "next/link";
import { guardianContactPath } from "@/lib/auth/redirect";
import { GuardianAttendanceAlerts } from "@/components/family/guardian-attendance-alerts";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  loadFamilyAttendance,
  loadFamilyStudents,
  rememberFamilyChild,
  restoreFamilyChild,
  type FamilyStudent,
} from "@/lib/attendance/family";
import { attendanceLabels, studentName } from "@/lib/attendance/types";
import { LoadingState } from "@/components/ui/skeleton";

const pageSize = 30;
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
});
const buttonClass = "rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-50";
type FamilyRole = "student" | "parent";
type Client = ReturnType<typeof createClient>;
type History = Awaited<ReturnType<typeof loadFamilyAttendance>>;

export function FamilyAttendanceRegister({ role, userId, initialChildId }: {
  role: FamilyRole;
  userId: string;
  initialChildId?: string;
}) {
  const [client] = useState(createClient);
  const [students, setStudents] = useState<FamilyStudent[]>();
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const student = students?.find((item) => item.id === selectedId);

  useEffect(() => {
    let active = true;
    loadFamilyStudents(client, role, userId).then((linked) => {
      if (!active) return;
      setStudents(linked);
      const requestedChild = linked.find((item) => item.id === initialChildId);
      setSelectedId(role === "parent"
        ? requestedChild?.id ?? restoreFamilyChild(userId, linked)
        : linked[0]?.id ?? "");
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Attendance access could not be loaded.");
    });
    return () => { active = false; };
  }, [attempt, client, initialChildId, role, userId]);

  function selectChild(id: string) {
    if (!students?.some((item) => item.id === id)) return;
    setSelectedId(id);
    rememberFamilyChild(userId, id);
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-3xl font-black">Attendance</h1>
        <p className="mt-2 text-sm muted">{role === "parent"
          ? "View the attendance history for your linked children."
          : "View your recorded attendance by date."}</p>
        {role === "parent" && <Link href={guardianContactPath}
          className="mt-3 inline-block text-sm font-semibold text-blue-700 hover:underline dark:text-blue-300">Guardian contact settings</Link>}
      </header>
      {role === "parent" && <GuardianAttendanceAlerts key={userId} userId={userId} summary />}
      {error ? (
        <section className="card space-y-3 p-4">
          <p role="alert" className="text-sm text-red-600">{error}</p>
          <button type="button" className={buttonClass} onClick={() => {
            setError("");
            setAttempt((value) => value + 1);
          }}>Retry access check</button>
        </section>
      ) : !students ? <LoadingState variant="form" className="text-sm muted">Checking attendance access…</LoadingState>
        : !student ? (
          <p className="card p-4 text-sm muted">{role === "parent"
            ? "No child is linked to this parent account."
            : "No student profile is linked to this account."}</p>
        ) : (
          <>
            {role === "parent" && (
              <label className="card block space-y-2 p-4 text-sm font-semibold">
                <span>Select child</span>
                <select value={selectedId} className="field max-w-xl" onChange={(event) => selectChild(event.target.value)}>
                  {students.map((item) => <option key={item.id} value={item.id}>{studentName(item)} · {item.admission_no}</option>)}
                </select>
              </label>
            )}
            <StudentHistory key={`${student.school_id}:${student.id}`} client={client} student={student} />
          </>
        )}
    </div>
  );
}

function StudentHistory({ client, student }: { client: Client; student: FamilyStudent }) {
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ page: number; attempt: number; history: History }>();
  const history = result?.page === page && result.attempt === attempt ? result.history : undefined;
  const offset = page * pageSize;

  useEffect(() => {
    let active = true;
    loadFamilyAttendance(client, student, { offset, limit: pageSize }).then((history) => {
      if (active) setResult({ page, attempt, history });
    }, () => {
      if (active) setResult({ page, attempt, history: { rows: [], count: 0, error: true } });
    });
    return () => { active = false; };
  }, [attempt, client, offset, page, student]);

  return (
    <section className="card overflow-hidden" aria-busy={!history}>
      <header className="border-b border-[var(--border)] p-4">
        <h2 className="font-bold">Attendance history</h2>
        <p className="mt-1 text-sm muted">{studentName(student)} · {student.admission_no}</p>
      </header>
      {!history ? <LoadingState variant="list" className="p-4 text-sm muted">Loading attendance…</LoadingState>
        : history.error ? (
          <div className="space-y-3 p-4">
            <p role="alert" className="text-sm text-red-600">Attendance could not be loaded.</p>
            <button type="button" className={buttonClass} onClick={() => setAttempt((value) => value + 1)}>Retry history</button>
          </div>
        ) : history.rows.length ? (
          <table aria-label="Attendance history" className="w-full text-left text-sm">
            <thead className="bg-[var(--surface-2)] muted">
              <tr><th scope="col" className="px-4 py-3">Date</th><th scope="col" className="px-4 py-3">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {history.rows.map((row) => (
                <tr key={row.attendance_date}>
                  <td className="px-4 py-3"><time dateTime={row.attendance_date}>{dateFormat.format(new Date(`${row.attendance_date}T00:00:00Z`))}</time></td>
                  <td className="px-4 py-3 font-semibold">{attendanceLabels[row.status] ?? row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="p-4 text-sm muted">{page ? "No attendance records on this page." : "No attendance records available."}</p>}
      {history && (page > 0 || history.count > pageSize) && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] p-4">
          <p className="text-sm muted">{history.rows.length
            ? `Showing ${offset + 1}–${offset + history.rows.length} of ${history.count} records`
            : `Page ${page + 1}`}</p>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button>
            <button type="button" className={buttonClass} disabled={history.error || offset + pageSize >= history.count}
              onClick={() => setPage((value) => value + 1)}>Next</button>
          </div>
        </footer>
      )}
    </section>
  );
}
