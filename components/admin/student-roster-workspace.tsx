"use client";

import Link from "next/link";
import { Upload, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { StudentPlacementDialog, StudentPlacementHistory } from "@/components/admin/student-roster-placements";
import { StudentDetailsDialog } from "@/components/admin/student-roster-details";
import { SectionPromotionDialog } from "@/components/admin/student-roster-promotion";
import { StudentRosterImport } from "@/components/admin/student-roster-import";
import { StudentWithdrawalDialog, StudentWithdrawalHistory } from "@/components/admin/student-roster-withdrawals";
import { loadAdminAttendanceSetup, loadEnrolledStudents, loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { studentName, type AttendanceContext, type AttendanceStudent } from "@/lib/attendance/types";
import { admitRosterStudent, RosterWriteError } from "@/lib/students/roster";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";

type Client = ReturnType<typeof createClient>;
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
type Setup = Awaited<ReturnType<typeof loadAdminAttendanceSetup>>;
type RosterStudent = Awaited<ReturnType<typeof loadEnrolledStudents>>[number];
type Load<T> = { data: T; error?: never } | { data?: never; error: string };
type SaveState = { message: string; error?: boolean };

const label = "block space-y-2 text-sm font-semibold";
const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60";
const link = "inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-blue-600 underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:no-underline dark:text-blue-400";
const reconcileNote = "Reload the roster before another admission. The previous request may already have saved; keep the same admission number while checking.";

// Stays mounted while closed, so a draft or an unconfirmed import survives closing like the old inline form.
// showModal() puts it in the top layer, above the sidebar, header and every z-index.
function RosterDialog({ open, title, locked, wide, onClose, children }: {
  open: boolean;
  title: string;
  locked: boolean;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    else if (!open && element?.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} aria-labelledby={titleId} onClose={onClose}
      onCancel={(event) => { if (locked) event.preventDefault(); }}
      className={`fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${wide ? "max-w-3xl" : "max-w-lg"} overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-xl backdrop:bg-slate-950/60 sm:p-6`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <h2 id={titleId} className="pt-2 text-lg font-bold">{title}</h2>
        <button type="button" aria-label="Close" disabled={locked} onClick={() => dialog.current?.close()}
          className="-mr-2 grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl muted hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-60">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function ReadFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <section className="card space-y-3 p-4">
      <p role="alert" className="text-sm text-danger">{error}</p>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>Try again</button>
    </section>
  );
}

function readError(error: unknown) {
  return { error: error instanceof Error ? error.message : "The roster could not be loaded. Try again." };
}

export function StudentRosterWorkspace({ userId, view = "students" }: { userId: string; view?: "students" | "admissions" }) {
  return <RosterWorkspace key={`${userId}:${view}`} userId={userId} view={view} />;
}

function RosterWorkspace({ userId, view }: { userId: string; view: "students" | "admissions" }) {
  const [client] = useState(createClient);
  const [access, setAccess] = useState<Load<Access>>();
  const [attempt, setAttempt] = useState(0);
  const [selectedSchool, setSelectedSchool] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);

  useEffect(() => {
    if (sessionChanged) return;
    let active = true;
    loadSchoolManagementAccess(client, "student enrollment", ["school_admin", "principal"]).then(
      (data) => {
        if (!active) return;
        if (data.userId === userId) setAccess({ data });
        else setSessionChanged(true);
      },
      (error: unknown) => { if (active) setAccess(readError(error)); },
    );
    return () => { active = false; };
  }, [client, userId, sessionChanged, attempt]);

  const schools = access?.data?.schools ?? [];
  const schoolId = selectedSchool || (schools.length === 1 ? schools[0].id : "");

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-[var(--primary)]">People</p>
        <h1 className="mt-1 text-2xl font-black sm:text-3xl">{view === "admissions" ? "Admissions" : "Students"}</h1>
        <p className="mt-2 text-sm leading-6 muted">{view === "admissions" ? "Admit a student or import a reviewed CSV into the current academic year, then verify the saved class register." : "Admit students and manage their class, section and academic year."}</p>
      </header>
      {sessionChanged ? <p role="alert" className="card p-4 text-sm text-danger">Your account changed. Reload this page to check access again.</p>
        : !access ? <LoadingState variant="form" className="text-sm muted">Checking school access…</LoadingState>
        : !access.data ? <ReadFailure error={access.error} onRetry={() => { setAccess(undefined); setAttempt((count) => count + 1); }} />
        : <>
            <label className={`card p-4 ${label}`}>
              <span>School</span>
              <select className="field" value={schoolId} disabled={busy || schools.length === 1}
                onChange={(event) => setSelectedSchool(event.target.value)}>
                <option value="">Select school</option>
                {schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
              </select>
            </label>
            {schoolId
              ? <SchoolRoster key={schoolId} client={client} userId={userId} schoolId={schoolId} view={view} busy={busy} onBusyChange={setBusy} />
              : <p className="text-sm muted">Select a school to open its roster.</p>}
          </>}
    </div>
  );
}

function SchoolRoster({ client, userId, schoolId, view, busy, onBusyChange }: {
  client: Client;
  userId: string;
  schoolId: string;
  view: "students" | "admissions";
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [setup, setSetup] = useState<Load<Setup>>();
  const [attempt, setAttempt] = useState(0);
  const [selectedClass, setSelectedClass] = useState("");
  const [selectedSection, setSelectedSection] = useState("");

  useEffect(() => {
    let active = true;
    loadAdminAttendanceSetup(client, schoolId, { activeClassesOnly: true, includePastYears: true }).then(
      (data) => { if (active) setSetup({ data }); },
      (error: unknown) => { if (active) setSetup(readError(error)); },
    );
    return () => { active = false; };
  }, [client, schoolId, attempt]);

  if (!setup) return <LoadingState variant="form" className="text-sm muted">Loading the academic year and classes…</LoadingState>;
  if (!setup.data) return <ReadFailure error={setup.error} onRetry={() => { setSetup(undefined); setAttempt((count) => count + 1); }} />;

  const { year, classes } = setup.data;
  const classId = selectedClass || (classes.length === 1 ? classes[0].id : "");
  const sections = setup.data.sections.filter((section) => section.class_id === classId);
  const sectionId = selectedSection || (sections.length === 1 ? sections[0].id : "");

  return (
    <>
      <div className="card grid gap-4 p-4 md:grid-cols-3">
        <div className={label}>
          <span>Academic year</span>
          <p className="py-2">{year.name}</p>
        </div>
        <label className={label}>
          <span>Class</span>
          <select className="field" value={classId} disabled={busy || !classes.length} onChange={(event) => {
            setSelectedClass(event.target.value);
            setSelectedSection("");
          }}>
            <option value="">Select class</option>
            {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className={label}>
          <span>Section</span>
          <select className="field" value={sectionId} disabled={busy || !sections.length}
            onChange={(event) => setSelectedSection(event.target.value)}>
            <option value="">Select section</option>
            {sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
          </select>
        </label>
      </div>
      {classId && sectionId
        ? <SectionRoster key={`${year.id}:${sectionId}`} client={client} userId={userId} schoolId={schoolId} academicYearId={year.id}
            classId={classId} sectionId={sectionId} view={view} setup={setup.data} busy={busy} onBusyChange={onBusyChange} />
        : <p className="text-sm muted">Choose an active class and section to continue.</p>}
    </>
  );
}

function SectionRoster({ client, userId, schoolId, academicYearId, classId, sectionId, view, setup, busy, onBusyChange }: AttendanceContext & {
  client: Client;
  userId: string;
  view: "students" | "admissions";
  setup: Setup;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [roster, setRoster] = useState<Load<RosterStudent[]>>();
  const [refresh, setRefresh] = useState(0);
  const [admissionNumber, setAdmissionNumber] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [registeredMobile, setRegisteredMobile] = useState("");
  const [detailsStudent, setDetailsStudent] = useState<RosterStudent>();
  const [status, setStatus] = useState<SaveState>();
  const [withdrawalStudent, setWithdrawalStudent] = useState<AttendanceStudent>();
  const [rosterNotice, setRosterNotice] = useState("");
  const [placementStudent, setPlacementStudent] = useState<RosterStudent>();
  const [promoting, setPromoting] = useState(false);
  const [mustReconcile, setMustReconcile] = useState(false);
  const [admitOpen, setAdmitOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  // Stable: the import re-subscribes (and aborts its save) whenever this callback changes.
  const importBusyChange = useCallback((value: boolean) => { setImportBusy(value); onBusyChange(value); }, [onBusyChange]);
  const saveInFlight = useRef(false);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => { operation.current?.abort(); }, []);

  useEffect(() => {
    let active = true;
    loadEnrolledStudents(client, { schoolId, academicYearId, classId, sectionId }, { activeStudentsOnly: true, enrollmentRollOnly: true }).then(
      (data) => { if (active) { setRoster({ data }); setMustReconcile(false); } },
      (error: unknown) => { if (active) setRoster(readError(error)); },
    );
    return () => { active = false; };
  }, [client, schoolId, academicYearId, classId, sectionId, refresh]);

  function reloadRoster() {
    setRoster(undefined);
    setRefresh((count) => count + 1);
  }

  async function admitStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saveInFlight.current || mustReconcile || !roster?.data) return;

    const controller = new AbortController(); operation.current = controller;
    saveInFlight.current = true;
    onBusyChange(true);
    setStatus(undefined);
    try {
      await admitRosterStudent(client, { schoolId, academicYearId, classId, sectionId }, {
        admissionNumber, firstName, lastName,
        ...(dateOfBirth ? { dateOfBirth } : {}), ...(registeredMobile.trim() ? { registeredMobile } : {}),
      }, { userId, signal: controller.signal });
      if (controller.signal.aborted) return;
      setAdmissionNumber("");
      setFirstName("");
      setLastName("");
      setDateOfBirth("");
      setRegisteredMobile("");
      setRosterNotice("Student admitted and enrolled.");
      setAdmitOpen(false);
      reloadRoster();
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setMustReconcile(!(error instanceof RosterWriteError) || error.code === "unconfirmed");
      setStatus({ message: readError(error).error, error: true });
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) { saveInFlight.current = false; onBusyChange(false); }
    }
  }

  return (
    <>
      <section className="card space-y-4 p-4" aria-label="Current class roster">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Current class roster</h2>
          <div className="flex flex-wrap gap-2">
            {view === "students" && setup.years.some((year) => !year.is_current && year.start_date > setup.year.end_date) &&
              <button type="button" className={button} disabled={busy || !roster?.data?.length}
                onClick={() => { setRosterNotice(""); setPromoting(true); }}>Promote this section</button>}
            <button type="button" className={button} disabled={busy || !roster} onClick={reloadRoster}>Reload roster</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6">
          <button type="button" className={link} aria-haspopup="dialog" disabled={busy || mustReconcile}
            onClick={() => { setRosterNotice(""); setAdmitOpen(true); }}>
            <UserPlus size={17} aria-hidden="true" /> Admit a student
          </button>
          <button type="button" className={link} aria-haspopup="dialog" onClick={() => { setRosterNotice(""); setImportOpen(true); }}>
            <Upload size={17} aria-hidden="true" /> Import students from CSV
          </button>
        </div>
        {mustReconcile && !admitOpen && <p className="text-sm leading-6 muted">{reconcileNote}</p>}
        {rosterNotice && <p role="status" className="text-sm">{rosterNotice}</p>}
        {!roster ? <LoadingState variant="table" className="text-sm muted">Loading roster…</LoadingState>
          : !roster.data ? <p role="alert" className="text-sm text-danger">{roster.error}</p>
          : !roster.data.length ? <p className="text-sm muted">No active students are enrolled in this section.</p>
          : <ul className="divide-y divide-[var(--border)]">
              {roster.data.map((student) => <li key={student.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 break-words py-3 text-sm">
                <div>
                  <p className="font-semibold">{studentName(student)}</p>
                  <p className="muted">{student.admission_no}</p>
                </div>
                {view === "students" && <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy} aria-label={`Edit details for ${studentName(student)}`}
                    onClick={() => { setRosterNotice(""); setDetailsStudent(student); }}
                    className={button}>Edit details</button>
                  <button type="button" disabled={busy} aria-label={`Change placement for ${studentName(student)}`}
                    onClick={() => { setRosterNotice(""); setPlacementStudent(student); }}
                    className={button}>Change placement</button>
                  <button type="button" disabled={busy} aria-label={`Withdraw ${studentName(student)}`}
                    onClick={() => { setRosterNotice(""); setWithdrawalStudent(student); }}
                    className={`${button} text-red-700 dark:text-red-400`}>Withdraw</button>
                </div>}
              </li>)}
            </ul>}
        <Link href="/modules/guardian-invitations" className="inline-block text-sm font-semibold text-blue-600 dark:text-blue-400">
          Open guardian invitations
        </Link>
      </section>

      <RosterDialog open={admitOpen} title="Admit a student" locked={busy} onClose={() => setAdmitOpen(false)}>
        <form className="space-y-4" onSubmit={(event) => void admitStudent(event)}>
          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={busy || mustReconcile || !roster?.data}>
            <label className={label}>
              <span>Admission number</span>
              <input className="field" value={admissionNumber} maxLength={64} required
                onChange={(event) => setAdmissionNumber(event.target.value)} />
            </label>
            <label className={label}>
              <span>First name</span>
              <input className="field" value={firstName} maxLength={100} required
                onChange={(event) => setFirstName(event.target.value)} />
            </label>
            <label className={label}>
              <span>Last name (optional)</span>
              <input className="field" value={lastName} maxLength={100}
                onChange={(event) => setLastName(event.target.value)} />
            </label>
            <label className={label}>
              <span>Date of birth (optional)</span>
              <input className="field" type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} />
            </label>
            <label className={label}>
              <span>Registered mobile (optional)</span>
              <input className="field" type="tel" inputMode="tel" value={registeredMobile} maxLength={20} placeholder="10 digit mobile number"
                onChange={(event) => setRegisteredMobile(event.target.value)} />
            </label>
          </fieldset>
          <p className="text-sm muted">The pupil needs a date of birth and registered mobile to activate a Student account. You can add them later with Edit details.</p>
          <button type="submit" className="btn btn-primary"
            disabled={busy || mustReconcile || !roster?.data || !admissionNumber.trim() || !firstName.trim()}>
            {busy ? "Saving…" : "Admit student"}
          </button>
          {status && <p role={status.error ? "alert" : "status"}
            className={status.error ? "text-sm text-danger" : "text-sm"}>
            {status.message}
          </p>}
          {mustReconcile && <p className="text-sm leading-6 muted">{reconcileNote}</p>}
        </form>
      </RosterDialog>

      <RosterDialog open={importOpen} title="Import students from CSV" locked={importBusy} wide onClose={() => setImportOpen(false)}>
        <StudentRosterImport client={client} ownerUserId={userId} context={{ schoolId, academicYearId, classId, sectionId }}
          disabled={busy || mustReconcile || !roster?.data} onBusyChange={importBusyChange} onImported={reloadRoster} />
      </RosterDialog>

      {view === "students" && <><StudentWithdrawalHistory client={client} context={{ schoolId, academicYearId, classId, sectionId }}
        currentAcademicYearId={setup.year.id} revision={refresh}
        busy={busy} onBusyChange={onBusyChange}
        onReinstated={(record) => { setRosterNotice(`${record.student_name} was reinstated.`); reloadRoster(); }} />
        <StudentPlacementHistory client={client} context={{ schoolId, academicYearId, classId, sectionId }}
          years={setup.years.filter((year) => year.start_date <= setup.year.start_date)} revision={refresh} /></>}
      {placementStudent && (
        <StudentPlacementDialog client={client} source={{ schoolId, academicYearId, classId, sectionId }}
          currentYear={setup.year} years={setup.years} classes={setup.classes} sections={setup.sections} student={placementStudent}
          onClose={() => setPlacementStudent(undefined)} onBusyChange={onBusyChange}
          onPlaced={(kind) => {
            const name = studentName(placementStudent);
            setRosterNotice(kind === "move"
              ? `${name} moved to the destination roster.`
              : `Promotion prepared for ${name}. Use Change placement to revise it before the destination year is activated.`);
            reloadRoster();
          }} />
      )}
      {promoting && roster?.data && (
        <SectionPromotionDialog client={client} source={{ schoolId, academicYearId, classId, sectionId }}
          currentYear={setup.year} years={setup.years} classes={setup.classes} sections={setup.sections} students={roster.data}
          onClose={() => setPromoting(false)} onBusyChange={onBusyChange}
          onStaged={({ staged, alreadyStaged }) => {
            setRosterNotice(`Promotion prepared for ${staged} student${staged === 1 ? "" : "s"}.${alreadyStaged
              ? ` ${alreadyStaged} already had a staged placement and kept it.` : ""} Use Change placement to revise one student before the destination year is activated.`);
            reloadRoster();
          }} />
      )}
      {detailsStudent && (
        <StudentDetailsDialog client={client} userId={userId} schoolId={schoolId} student={detailsStudent}
          onClose={() => setDetailsStudent(undefined)} onBusyChange={onBusyChange}
          onSaved={() => { setRosterNotice(`Details saved for ${studentName(detailsStudent)}.`); reloadRoster(); }} />
      )}
      {withdrawalStudent && (
        <StudentWithdrawalDialog client={client} context={{ schoolId, academicYearId, classId, sectionId }} student={withdrawalStudent}
          onClose={() => setWithdrawalStudent(undefined)} onBusyChange={onBusyChange}
          onWithdrawn={() => { setRosterNotice(`${studentName(withdrawalStudent)} was withdrawn.`); reloadRoster(); }} />
      )}
    </>
  );
}
