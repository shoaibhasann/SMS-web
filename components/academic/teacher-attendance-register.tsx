"use client";

import { useEffect, useRef, useState } from "react";
import { AttendanceEditor } from "@/components/academic/attendance-editor";
import { AttendanceCorrectionQueue } from "@/components/academic/attendance-correction-queue";
import { createClient } from "@/lib/supabase/client";
import { loadEffectiveAttendanceAssignments, type EffectiveAttendanceAssignment } from "@/lib/assignments/attendance-coverage";
import { useAttendanceAccessRevalidation } from "@/lib/assignments/use-attendance-access";
import type { AttendanceContext } from "@/lib/attendance/types";
import { LoadingState } from "@/components/ui/skeleton";

type Register = {
  context: AttendanceContext;
  userId: string;
  teacherName: string;
  className: string;
  sectionName: string;
  assignment: EffectiveAttendanceAssignment;
};

export function TeacherAttendanceRegister() {
  const [client] = useState(createClient);
  const [register, setRegister] = useState<Register | null>(null);
  const [choices, setChoices] = useState<EffectiveAttendanceAssignment[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [accessRevision, setAccessRevision] = useState(0);
  const [accessLoaded, setAccessLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [attendanceLocked, setAttendanceLocked] = useState(true);
  const [rosterVersion, setRosterVersion] = useState(0);
  const [showRequests, setShowRequests] = useState(false);
  const [requestRevision, setRequestRevision] = useState(0);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [studentName, setStudentName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registrationMessage, setRegistrationMessage] = useState("");
  const registrationInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    async function load() {
      const { data: { user }, error: authError } = await client.auth.getUser();
      if (authError) throw authError;
      if (!user) throw new Error("Please sign in to open your attendance register.");
      const { data: teacher, error: teacherError } = await client.from("teachers")
        .select("id,school_id,full_name").eq("profile_id", user.id).maybeSingle();
      if (teacherError) throw teacherError;
      if (!teacher) throw new Error("A teacher profile is not linked to this account.");
      const { data: year, error: yearError } = await client.from("academic_years")
        .select("id").eq("school_id", teacher.school_id).eq("is_current", true).maybeSingle();
      if (yearError) throw yearError;
      if (!year) throw new Error("No current academic year is configured. Ask the school administrator.");
      const available = (await loadEffectiveAttendanceAssignments(client)).filter((item) => item.academic_year_id === year.id);
      if (!active) return;
      setChoices(available);
      setAccessLoaded(true);
      const assignment = available.find((item) => item.id === selectedId) ?? available[0];
      if (!assignment) throw new Error("An assigned class teacher section is required. Ask the school administrator.");
      if (active) setRegister({
        userId: user.id,
        teacherName: teacher.full_name || user.email || "Teacher",
        context: { schoolId: teacher.school_id, academicYearId: year.id, classId: assignment.class_id, sectionId: assignment.section_id },
        className: assignment.class_name,
        sectionName: assignment.section_name,
        assignment,
      });
    }
    load().catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "Attendance register could not be loaded.");
    });
    return () => { active = false; };
  }, [client, selectedId, accessRevision]);

  function refreshAccess() {
    setLoadError(""); setRegister(null); setRegistrationOpen(false); setAttendanceLocked(true);
    setAccessLoaded(false); setAccessRevision((value) => value + 1);
  }

  useAttendanceAccessRevalidation({ client, enabled: accessLoaded, assignments: choices,
    onChanged: refreshAccess,
    onUnavailable: () => {
      setRegister(null); setChoices([]); setRegistrationOpen(false);
      setLoadError("Your attendance access could not be verified. Refresh to check your access.");
    },
  });

  const mayRegister = Boolean(register && !register.assignment.coverage_id && choices.filter((item) => !item.coverage_id).length === 1);

  async function registerStudent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = studentName.trim();
    if (!register || !mayRegister || !name || registrationInFlight.current || attendanceLocked) return;
    registrationInFlight.current = true;
    setRegistering(true);
    setRegistrationMessage("");
    try {
      const { error } = await client.rpc("register_student_for_class_teacher", { p_full_name: name });
      if (error) throw error;
      setRosterVersion((value) => value + 1);
      setRegistrationOpen(false);
      setStudentName("");
      setRegistrationMessage(`${name} registered. Reloading the class register.`);
    } catch (error: unknown) {
      setRegistrationMessage(error instanceof Error ? error.message : "Student could not be registered. Check the register before retrying.");
    } finally {
      registrationInFlight.current = false;
      setRegistering(false);
    }
  }

  if (loadError) return <div className="space-y-3"><p role="alert" className="rounded-xl border border-red-500/30 p-4 text-sm text-red-600">{loadError}</p>
    <button type="button" className="min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" onClick={refreshAccess}>Refresh attendance access</button></div>;
  if (!register) return <LoadingState variant="table" className="text-sm muted">Loading your attendance register…</LoadingState>;

  return (
    <div className="space-y-5">
      <header className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <h1 className="text-2xl font-bold">Attendance Register</h1>
          <p className="mt-1 text-sm muted">{register.teacherName} · {register.className} / {register.sectionName}</p>
          {register.assignment.coverage_id && <p className="mt-1 text-sm font-semibold text-blue-700 dark:text-blue-300">Temporary attendance coverage · {register.assignment.starts_on} through {register.assignment.ends_on} IST</p>}
        </div>
        {mayRegister && <button type="button" onClick={() => setRegistrationOpen((value) => !value)} disabled={attendanceLocked || registering} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">{registrationOpen ? "Cancel registration" : "Register Student"}</button>}
      </header>
      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <label className="block w-full min-w-0 space-y-2 text-sm font-semibold sm:flex-1">Attendance class
          <select className="field" value={register.assignment.id} disabled={attendanceLocked || registering} onChange={(event) => {
            setSelectedId(event.target.value); setRegister(null); setLoadError(""); setAttendanceLocked(true);
            setRegistrationOpen(false); setStudentName(""); setRegistrationMessage("");
          }}>{choices.map((item) => <option key={item.id} value={item.id}>{item.class_name} / {item.section_name}{item.coverage_id ? " · Temporary coverage" : " · Class teacher"}</option>)}</select>
        </label>
        <button type="button" disabled={attendanceLocked || registering} className="min-h-11 w-full rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold sm:w-auto" onClick={refreshAccess}>Refresh attendance access</button>
      </div>
      {registrationOpen && mayRegister && (
        <form onSubmit={registerStudent} className="card space-y-3 p-5">
          <label className="block text-sm font-semibold">Student name
            <input required value={studentName} onChange={(event) => setStudentName(event.target.value)} disabled={registering || attendanceLocked} className="field mt-2" />
          </label>
          <p className="text-xs muted">Save or discard attendance edits before registering a student.</p>
          <button disabled={registering || attendanceLocked || !studentName.trim()} className="rounded-xl gradient px-4 py-2.5 text-sm font-semibold disabled:opacity-50">{registering ? "Registering…" : "Register Student"}</button>
        </form>
      )}
      {registrationMessage && <p role="status" className="text-sm">{registrationMessage}</p>}
      <div className="card p-5">
        {registering && <p role="status" className="mb-3 text-sm">Registering student…</p>}
        <fieldset disabled={registering}>
          <AttendanceEditor context={register.context} userId={register.userId} rosterVersion={rosterVersion}
            onLockChange={setAttendanceLocked}
            reviewOnlyHistory={Boolean(register.assignment.coverage_id)}
            dateLimits={register.assignment.coverage_id && register.assignment.starts_on && register.assignment.ends_on
              ? { start: register.assignment.starts_on, end: register.assignment.ends_on } : undefined} onCorrectionRequested={() => {
              setRequestRevision((value) => value + 1);
              setShowRequests(true);
            }} />
        </fieldset>
      </div>
      {!register.assignment.coverage_id && <button type="button" aria-expanded={showRequests} onClick={() => setShowRequests((value) => !value)} className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold">
        {showRequests ? "Hide my correction requests" : "Show my correction requests"}
      </button>}
      {showRequests && !register.assignment.coverage_id && <AttendanceCorrectionQueue client={client} schoolId={register.context.schoolId}
        userId={register.userId} own revision={requestRevision} />}
    </div>
  );
}
