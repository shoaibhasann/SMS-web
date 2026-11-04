"use client";

import { useEffect, useRef, useState } from "react";
import { AttendanceEditor } from "@/components/academic/attendance-editor";
import { createClient } from "@/lib/supabase/client";
import type { AttendanceContext } from "@/lib/attendance/types";

type Register = {
  context: AttendanceContext;
  userId: string;
  teacherName: string;
  className: string;
  sectionName: string;
};

export function TeacherAttendanceRegister() {
  const [client] = useState(createClient);
  const [register, setRegister] = useState<Register | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attendanceLocked, setAttendanceLocked] = useState(true);
  const [rosterVersion, setRosterVersion] = useState(0);
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
      const { data: assignment, error: assignmentError } = await client.from("teacher_subject_assignments")
        .select("class_id,section_id").eq("teacher_id", teacher.id)
        .eq("academic_year_id", year.id).eq("is_class_teacher", true).limit(1).maybeSingle();
      if (assignmentError) throw assignmentError;
      if (!assignment?.section_id) throw new Error("An assigned class teacher section is required. Ask the school administrator.");
      const [classResult, sectionResult] = await Promise.all([
        client.from("classes").select("name").eq("id", assignment.class_id).eq("school_id", teacher.school_id).single(),
        client.from("sections").select("name").eq("id", assignment.section_id).eq("class_id", assignment.class_id).eq("school_id", teacher.school_id).single(),
      ]);
      if (classResult.error) throw classResult.error;
      if (sectionResult.error) throw sectionResult.error;
      if (active) setRegister({
        userId: user.id,
        teacherName: teacher.full_name || user.email || "Teacher",
        context: { schoolId: teacher.school_id, academicYearId: year.id, classId: assignment.class_id, sectionId: assignment.section_id },
        className: classResult.data.name,
        sectionName: sectionResult.data.name,
      });
    }
    load().catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "Attendance register could not be loaded.");
    });
    return () => { active = false; };
  }, [client]);

  async function registerStudent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = studentName.trim();
    if (!register || !name || registrationInFlight.current || attendanceLocked) return;
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

  if (loadError) return <p role="alert" className="rounded-xl border border-red-500/30 p-4 text-sm text-red-600">{loadError}</p>;
  if (!register) return <p role="status" className="text-sm muted">Loading your attendance register…</p>;

  return (
    <div className="space-y-5">
      <header className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <h1 className="text-2xl font-bold">Attendance Register</h1>
          <p className="mt-1 text-sm muted">Class Teacher: {register.teacherName} · {register.className} / {register.sectionName}</p>
        </div>
        <button type="button" onClick={() => setRegistrationOpen((value) => !value)} disabled={attendanceLocked || registering} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">{registrationOpen ? "Cancel registration" : "Register Student"}</button>
      </header>
      {registrationOpen && (
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
          <AttendanceEditor context={register.context} userId={register.userId} rosterVersion={rosterVersion} onLockChange={setAttendanceLocked} />
        </fieldset>
      </div>
    </div>
  );
}
