"use client";

import { useEffect, useState } from "react";
import { AttendanceEditor } from "@/components/academic/attendance-editor";
import { AttendanceCorrectionQueue } from "@/components/academic/attendance-correction-queue";
import { AttendanceSubmissionMonitor } from "@/components/admin/attendance-submission-monitor";
import { loadAdminAttendanceAccess, loadAdminAttendanceSetup } from "@/lib/attendance/repository";
import { schoolDate } from "@/lib/attendance/types";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";

type Client = ReturnType<typeof createClient>;
type Access = Awaited<ReturnType<typeof loadAdminAttendanceAccess>>;
type Setup = Awaited<ReturnType<typeof loadAdminAttendanceSetup>>;
type LoadState<T> = { data: T; error?: never } | { data?: never; error: string };

function loadError(error: unknown) {
  return { error: error instanceof Error ? error.message : "Attendance could not be loaded. Try again." };
}

export function AdminAttendanceWorkspace({ principal = false }: { principal?: boolean }) {
  const [client] = useState(createClient);
  const [access, setAccess] = useState<LoadState<Access>>();
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [selectedSchool, setSelectedSchool] = useState("");
  const [locked, setLocked] = useState(false);
  const [showCorrections, setShowCorrections] = useState(false);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [monitorRevision, setMonitorRevision] = useState(0);
  const [cutoffSaving, setCutoffSaving] = useState(false);
  const scopeLocked = locked || cutoffSaving;

  useEffect(() => {
    let active = true;
    loadAdminAttendanceAccess(client, principal).then(
      (data) => { if (active) setAccess({ data }); },
      (error: unknown) => { if (active) setAccess(loadError(error)); },
    );
    return () => { active = false; };
  }, [client, principal, accessAttempt]);

  const schools = access?.data?.schools ?? [];
  const schoolId = selectedSchool || (schools.length === 1 ? schools[0].id : "");

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-600">School Administration</p>
        <h1 className="mt-1 text-3xl font-black">Attendance</h1>
        <p className="mt-2 text-sm muted">Record current attendance or view saved registers from earlier academic years.</p>
      </header>
      {!access ? <LoadingState variant="form" className="text-sm muted">Checking attendance access…</LoadingState>
        : !access.data ? (
          <section className="card space-y-3 p-4">
            <p role="alert" className="text-sm text-red-600">{access.error}</p>
            <button type="button" className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm" onClick={() => {
              setAccess(undefined);
              setAccessAttempt((attempt) => attempt + 1);
            }}>Retry access check</button>
          </section>
        ) : (
          <>
            <label className="card block space-y-2 p-4 text-sm font-semibold">
              <span>School</span>
              <select className="field" value={schoolId} disabled={scopeLocked || schools.length === 1}
                onChange={(event) => setSelectedSchool(event.target.value)}>
                <option value="">Select school</option>
                {schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
              </select>
            </label>
            {schoolId ? <>
              <AttendanceSubmissionMonitor key={`monitor:${schoolId}`} schoolId={schoolId} userId={access.data.userId}
                settings disabled={scopeLocked} refreshVersion={monitorRevision} onBusyChange={setCutoffSaving} />
              <button type="button" aria-expanded={showCorrections} className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold"
                onClick={() => setShowCorrections((value) => !value)}>{showCorrections ? "Hide attendance corrections" : "Review attendance corrections"}</button>
              {showCorrections && <AttendanceCorrectionQueue key={schoolId} client={client} schoolId={schoolId}
                userId={access.data.userId} disabled={scopeLocked} onReviewed={() => {
                  setReviewRevision((value) => value + 1);
                  setMonitorRevision((value) => value + 1);
                }} />}
              <fieldset disabled={cutoffSaving} className="min-w-0 space-y-6">
                <SchoolAttendance key={schoolId} client={client} schoolId={schoolId}
                  userId={access.data.userId} locked={scopeLocked} onLockChange={setLocked} reviewRevision={reviewRevision}
                  onSaved={() => setMonitorRevision((value) => value + 1)} />
              </fieldset>
            </>
              : <p className="text-sm muted">Select a school to open its register.</p>}
          </>
        )}
    </div>
  );
}

function SchoolAttendance({ client, schoolId, userId, locked, onLockChange, reviewRevision, onSaved }: {
  client: Client;
  schoolId: string;
  userId: string;
  locked: boolean;
  onLockChange: (locked: boolean) => void;
  reviewRevision: number;
  onSaved: () => void;
}) {
  const [setup, setSetup] = useState<LoadState<Setup>>();
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [selectedYear, setSelectedYear] = useState("");
  const [selectedClass, setSelectedClass] = useState("");
  const [selectedSection, setSelectedSection] = useState("");

  useEffect(() => {
    let active = true;
    loadAdminAttendanceSetup(client, schoolId, { includePastYears: true }).then(
      (data) => { if (active) setSetup({ data }); },
      (error: unknown) => { if (active) setSetup(loadError(error)); },
    );
    return () => { active = false; };
  }, [client, schoolId, setupAttempt]);

  if (!setup) return <LoadingState variant="form" className="text-sm muted">Loading the school register setup…</LoadingState>;
  if (!setup.data) return (
    <section className="card space-y-3 p-4">
      <p role="alert" className="text-sm text-red-600">{setup.error}</p>
      <button type="button" className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm" onClick={() => {
        setSetup(undefined);
        setSetupAttempt((attempt) => attempt + 1);
      }}>Retry school setup</button>
    </section>
  );

  const { year: currentYear, years, classes, sections } = setup.data;
  const today = schoolDate();
  const availableYears = years.filter((year) => year.is_current || year.start_date <= today);
  const year = availableYears.find((item) => item.id === selectedYear) ?? currentYear;
  const classId = selectedClass || (classes.length === 1 ? classes[0].id : "");
  const classSections = sections.filter((section) => section.class_id === classId);
  const sectionId = selectedSection || (classSections.length === 1 ? classSections[0].id : "");

  return (
    <>
      <section className="card grid gap-4 p-4 sm:grid-cols-3">
        <label className="space-y-2 text-sm font-semibold">
          <span>Academic year</span>
          <select className="field" value={year.id} disabled={locked || availableYears.length === 1}
            onChange={(event) => setSelectedYear(event.target.value)}>
            {availableYears.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="space-y-2 text-sm font-semibold">
          <span>Class</span>
          <select className="field" value={classId} disabled={locked || !classes.length} onChange={(event) => {
            setSelectedClass(event.target.value);
            setSelectedSection("");
          }}>
            <option value="" disabled>Select class</option>
            {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="space-y-2 text-sm font-semibold">
          <span>Section</span>
          <select className="field" value={sectionId} disabled={locked || !classSections.length}
            onChange={(event) => setSelectedSection(event.target.value)}>
            <option value="" disabled>Select section</option>
            {classSections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      </section>
      {year.start_date > today ? <p className="text-sm muted">This academic year begins on {year.start_date}.</p> : classId && sectionId ? (
        <section className="card space-y-4 p-4">
          <h2 className="font-bold">Attendance register</h2>
          <AttendanceEditor context={{ schoolId, academicYearId: year.id, classId, sectionId }}
            userId={userId} onLockChange={onLockChange} onSaved={onSaved} studentSearch reviewOnlyHistory rosterVersion={reviewRevision}
            dateLimits={{ start: year.start_date, end: year.end_date }} readOnly={!year.is_current} />
        </section>
      ) : (
        <p className="text-sm muted">{!classes.length ? "Add a class and section in Academic Setup to open its register."
          : classId && !classSections.length ? "This class has no sections."
          : "Select a class and section to open its register."}</p>
      )}
    </>
  );
}
