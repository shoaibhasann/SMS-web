"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  loadAdminAttendanceSetup,
  loadEnrolledStudents,
  loadSchoolManagementAccess,
} from "@/lib/attendance/repository";
import { studentName, type AttendanceStudent } from "@/lib/attendance/types";
import {
  guardianInvitationUrl,
  invitationStatus,
  issueGuardianInvitation,
  issueGuardianPhoneInvitation,
  listGuardianInvitations,
  revokeGuardianInvitation,
  type GuardianInvitation,
} from "@/lib/guardian-invitations/admin";
import { GuardianAccessWorkspace } from "./guardian-access-workspace";
import { GuardianInvitationImport } from "./guardian-invitation-import";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";
import { normalizeIndianMobile } from "@/lib/auth/phone";

type Client = ReturnType<typeof createClient>;
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
type Setup = Awaited<ReturnType<typeof loadAdminAttendanceSetup>>;
type Load<T> = { data: T; error?: never } | { data?: never; error: string };
type LockProps = { busy: boolean; onBusyChange: (busy: boolean) => void };
type NewLink = { id: string; url: string; contact: string; expiresAt: string };
type Notice = { text: string; error?: boolean };

const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-60";
const label = "block min-w-0 space-y-2 text-sm font-semibold";
const expiryFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

function requestError(error: unknown) {
  return { error: error instanceof Error ? error.message : "The request could not be completed. Try again." };
}

function ReadFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
      <button type="button" className={button} onClick={onRetry}>Try again</button>
    </div>
  );
}

export function GuardianInvitationsWorkspace({ userId }: { userId: string }) {
  const [client] = useState(createClient);
  const [access, setAccess] = useState<Load<Access>>();
  const [attempt, setAttempt] = useState(0);
  const [school, setSchool] = useState("");
  const [busy, setBusy] = useState(false);
  const [accessRevision, setAccessRevision] = useState(0);
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
    loadSchoolManagementAccess(client, "guardian invitations", ["school_admin", "principal"]).then(
      (data) => {
        if (!active) return;
        if (data.userId === userId) setAccess({ data });
        else setSessionChanged(true);
      },
      (error: unknown) => { if (active) setAccess(requestError(error)); },
    );
    return () => { active = false; };
  }, [client, userId, attempt, sessionChanged]);

  const schools = access?.data?.schools ?? [];
  const schoolId = school || (schools.length === 1 ? schools[0].id : "");
  const canManageLinkedAccess = access?.data?.schoolAdminIds.includes(schoolId);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-600 dark:text-blue-300">People</p>
        <h1 className="mt-1 text-3xl font-black">Guardian invitations</h1>
        <p className="mt-2 text-sm muted">Invite guardians to view their linked students’ school records.</p>
      </header>
      {sessionChanged ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">Your account changed. Refresh this page to check access again.</p>
        : !access ? <LoadingState variant="form" className="text-sm muted">Checking invitation access…</LoadingState>
        : access.error ? <ReadFailure error={access.error} onRetry={() => {
          setAccess(undefined);
          setAttempt((value) => value + 1);
        }} />
        : <>
          <section className="card p-4">
            <label className={label}>School
              <select className="field" value={schoolId} disabled={busy || schools.length === 1}
                onChange={(event) => setSchool(event.target.value)}>
                <option value="">Select school</option>
                {schools.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          </section>
          {schoolId ? <>
            {canManageLinkedAccess && <GuardianAccessWorkspace key={`guardian-access:${schoolId}`} client={client}
              schoolId={schoolId} busy={busy} onBusyChange={setBusy}
              onInvitationsChanged={() => setAccessRevision((revision) => revision + 1)} />}
            <SchoolInvitations key={schoolId} client={client} schoolId={schoolId} busy={busy}
              onBusyChange={setBusy} accessRevision={accessRevision} />
          </> : <p className="text-sm muted">Select a school to find an enrolled student.</p>}
        </>}
    </div>
  );
}

function SchoolInvitations({ client, schoolId, busy, onBusyChange, accessRevision }: LockProps & {
  client: Client;
  schoolId: string;
  accessRevision: number;
}) {
  const [setup, setSetup] = useState<Load<Setup>>();
  const [attempt, setAttempt] = useState(0);
  const [pickedClass, setPickedClass] = useState("");
  const [pickedSection, setPickedSection] = useState("");
  const [importRevision, setImportRevision] = useState(0);

  useEffect(() => {
    let active = true;
    loadAdminAttendanceSetup(client, schoolId).then(
      (data) => { if (active) setSetup({ data }); },
      (error: unknown) => { if (active) setSetup(requestError(error)); },
    );
    return () => { active = false; };
  }, [client, schoolId, attempt]);

  if (!setup) return <LoadingState variant="form" className="text-sm muted">Loading classes and sections…</LoadingState>;
  if (!setup.data) return <ReadFailure error={setup.error} onRetry={() => {
    setSetup(undefined);
    setAttempt((value) => value + 1);
  }} />;

  const { year, classes, sections } = setup.data;
  const classId = pickedClass || (classes.length === 1 ? classes[0].id : "");
  const classSections = sections.filter((item) => item.class_id === classId);
  const sectionId = pickedSection || (classSections.length === 1 ? classSections[0].id : "");
  return (
    <>
      <GuardianInvitationImport client={client} schoolId={schoolId} busy={busy} onBusyChange={onBusyChange}
        onImported={() => setImportRevision((revision) => revision + 1)} />
      <section className="card grid gap-4 p-4 sm:grid-cols-3">
        <div className="space-y-2 text-sm">
          <p className="font-semibold">Academic year</p>
          <p>{year.name}</p>
        </div>
        <label className={label}>Class
          <select className="field" value={classId} disabled={busy || !classes.length}
            onChange={(event) => { setPickedClass(event.target.value); setPickedSection(""); }}>
            <option value="">Select class</option>
            {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className={label}>Section
          <select className="field" value={sectionId} disabled={busy || !classSections.length}
            onChange={(event) => setPickedSection(event.target.value)}>
            <option value="">Select section</option>
            {classSections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      </section>
      {classId && sectionId ? (
        <RosterInvitations key={sectionId} client={client} schoolId={schoolId} yearId={year.id}
          classId={classId} sectionId={sectionId} historyRevision={importRevision + accessRevision}
          busy={busy} onBusyChange={onBusyChange} />
      ) : <p className="text-sm muted">Select a class and section with an active roster.</p>}
    </>
  );
}

function RosterInvitations({ client, schoolId, yearId, classId, sectionId, historyRevision, busy, onBusyChange }: LockProps & {
  client: Client;
  schoolId: string;
  yearId: string;
  classId: string;
  sectionId: string;
  historyRevision: number;
}) {
  const [roster, setRoster] = useState<Load<AttendanceStudent[]>>();
  const [attempt, setAttempt] = useState(0);
  const [studentId, setStudentId] = useState("");

  useEffect(() => {
    let active = true;
    loadEnrolledStudents(client, { schoolId, academicYearId: yearId, classId, sectionId }, { activeStudentsOnly: true }).then(
      (data) => { if (active) setRoster({ data }); },
      (error: unknown) => { if (active) setRoster(requestError(error)); },
    );
    return () => { active = false; };
  }, [client, schoolId, yearId, classId, sectionId, attempt]);

  if (!roster) return <LoadingState variant="table" className="text-sm muted">Loading enrolled students…</LoadingState>;
  if (!roster.data) return <ReadFailure error={roster.error} onRetry={() => {
    setRoster(undefined);
    setAttempt((value) => value + 1);
  }} />;
  if (!roster.data.length) return <p className="text-sm muted">No active students are enrolled in this section.</p>;

  const student = roster.data.find((item) => item.id === studentId);
  return (
    <>
      <section className="card p-4">
        <label className={label}>Student
          <select className="field" value={studentId} disabled={busy} onChange={(event) => setStudentId(event.target.value)}>
            <option value="">Select student</option>
            {roster.data.map((item) => <option key={item.id} value={item.id}>{studentName(item)} · {item.admission_no}</option>)}
          </select>
        </label>
      </section>
      {student && <StudentInvitations key={student.id} client={client} schoolId={schoolId}
        student={student} historyRevision={historyRevision} busy={busy} onBusyChange={onBusyChange} />}
    </>
  );
}

function StudentInvitations({ client, schoolId, student, historyRevision, busy, onBusyChange }: LockProps & {
  client: Client;
  schoolId: string;
  student: AttendanceStudent;
  historyRevision: number;
}) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [link, setLink] = useState<NewLink>();
  const [notice, setNotice] = useState<Notice>();
  const [history, setHistory] = useState<Load<{ invitations: GuardianInvitation[]; checkedAt: number }>>();
  const [attempt, setAttempt] = useState(0);
  const [pendingRevoke, setPendingRevoke] = useState<GuardianInvitation>();
  const [action, setAction] = useState<"issue" | "revoke">();
  const inFlight = useRef(false);
  const active = useRef(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const { id: studentId } = student;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    listGuardianInvitations(client, schoolId, studentId).then(
      (invitations) => { if (current) setHistory({ data: { invitations, checkedAt: Date.now() } }); },
      (error: unknown) => { if (current) setHistory(requestError(error)); },
    );
    return () => { current = false; };
  }, [client, schoolId, studentId, attempt, historyRevision]);

  function refresh() {
    setHistory(undefined);
    setAttempt((value) => value + 1);
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedContact = method === "email" ? email.trim().toLowerCase() : normalizeIndianMobile(phone);
    if (inFlight.current || pendingRevoke) return;
    if (!submittedContact) {
      setNotice({ text: method === "phone" ? "Enter a valid Indian mobile number." : "Enter the guardian’s full email address.", error: true });
      return;
    }
    inFlight.current = true;
    onBusyChange(true);
    setAction("issue");
    setLink(undefined);
    setNotice(undefined);
    try {
      const result = method === "phone"
        ? await issueGuardianPhoneInvitation(client, schoolId, studentId, submittedContact)
        : await issueGuardianInvitation(client, schoolId, studentId, submittedContact);
      if (!active.current) return;
      const url = guardianInvitationUrl(result.token, window.location.origin, method);
      setLink({ id: result.id, url, contact: submittedContact, expiresAt: result.expires_at });
      setEmail("");
      setPhone("");
      setNotice({ text: "Invitation created. Copy the link and share it privately with the guardian." });
    } catch (error: unknown) {
      if (active.current) setNotice({ text: requestError(error).error, error: true });
    } finally {
      inFlight.current = false;
      if (active.current) {
        onBusyChange(false);
        setAction(undefined);
        refresh();
      }
    }
  }

  async function revoke() {
    if (!pendingRevoke || inFlight.current) return;
    const { id } = pendingRevoke;
    inFlight.current = true;
    onBusyChange(true);
    setAction("revoke");
    setNotice(undefined);
    try {
      const revoked = await revokeGuardianInvitation(client, id);
      if (!active.current) return;
      setLink((current) => current?.id === id ? undefined : current);
      setPendingRevoke(undefined);
      setNotice(revoked ? { text: "Invitation revoked." }
        : { text: "This invitation is no longer pending. Check the updated history.", error: true });
    } catch (error: unknown) {
      if (active.current) setNotice({ text: requestError(error).error, error: true });
    } finally {
      inFlight.current = false;
      if (active.current) {
        onBusyChange(false);
        setAction(undefined);
        refresh();
      }
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      if (active.current) setNotice({ text: "Invitation link copied." });
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      if (active.current) setNotice({ text: "Automatic copy is unavailable. Copy the selected link manually.", error: true });
    }
  }

  const loadedHistory = history?.data;
  const listedLink = loadedHistory?.invitations.find((invitation) => invitation.id === link?.id);
  const displayLink = link && (!listedLink || !loadedHistory || invitationStatus(listedLink, loadedHistory.checkedAt) === "Pending");

  return (
    <>
      <section className="card space-y-4 p-4 sm:p-5">
        <div className="space-y-1">
          <h2 className="font-bold">Invite a guardian for {studentName(student)}</h2>
          <p className="text-sm muted">The guardian verifies the invited email or mobile before accepting. Each link expires after 72 hours and can be used once. Mobile OTP requires the school’s SMS service to be activated.</p>
        </div>
        <form onSubmit={(event) => void issue(event)} className="space-y-3">
          <fieldset disabled={busy || Boolean(pendingRevoke)} className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Invitation method</legend>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex min-h-11 cursor-pointer items-center gap-2">
                  <input type="radio" name={`guardian-method-${studentId}`} value="email" checked={method === "email"}
                    onChange={() => { setMethod("email"); setNotice(undefined); }} /> Email
                </label>
                <label className="flex min-h-11 cursor-pointer items-center gap-2">
                  <input type="radio" name={`guardian-method-${studentId}`} value="phone" checked={method === "phone"}
                    onChange={() => { setMethod("phone"); setNotice(undefined); }} /> Mobile OTP
                </label>
              </div>
            </fieldset>
            {method === "email" ? <label className={label}>Guardian email
              <input className="field" type="email" autoComplete="off" required maxLength={254}
                value={email} onChange={(event) => setEmail(event.target.value)} />
            </label> : <label className={label}>Guardian mobile
              <input className="field" type="tel" inputMode="tel" autoComplete="off" required maxLength={18}
                placeholder="98765 43210" value={phone} onChange={(event) => setPhone(event.target.value)} />
            </label>}
            <p className="text-sm muted">Creating a new invitation for the same student and contact replaces the previous pending link.</p>
            {method === "phone" && <p className="text-sm muted">Mobile verification needs the school’s SMS service. Existing email guardians should verify their mobile from their current account to preserve child links.</p>}
            <button type="submit" className={`${button} bg-blue-700 text-white`}>{action === "issue" ? "Creating invitation…" : "Create invitation"}</button>
          </fieldset>
        </form>
        {displayLink && (
          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <label className={label}>Invitation link
              <input className="field" ref={linkInput} readOnly value={link.url} />
            </label>
            <p className="text-sm muted break-words">For {link.contact}. Expires {expiryFormat.format(Date.parse(link.expiresAt))} IST. Copy it before leaving this student’s screen.</p>
            <button type="button" className={button} disabled={busy} onClick={() => void copy()}>Copy link</button>
          </div>
        )}
        {notice && <p role={notice.error ? "alert" : "status"}
          className={`text-sm ${notice.error ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-300"}`}>{notice.text}</p>}
      </section>
      <section className="card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold">Invitation history</h2>
            <p className="text-sm muted">Latest 50 invitations for this student.</p>
          </div>
          <button type="button" className={button} disabled={busy || !history || Boolean(pendingRevoke)} onClick={refresh}>Refresh invitations</button>
        </div>
        {pendingRevoke && (
          <div role="group" aria-label="Confirm revocation" className="space-y-3 rounded-xl border border-red-500/40 p-4">
            <p className="text-sm break-words">Revoke the pending link for {pendingRevoke.email || pendingRevoke.phone}?</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={`${button} text-red-600 dark:text-red-400`} disabled={busy}
                onClick={() => void revoke()}>{action === "revoke" ? "Revoking…" : "Confirm revoke"}</button>
              <button type="button" className={button} disabled={busy} onClick={() => setPendingRevoke(undefined)}>Keep invitation</button>
            </div>
          </div>
        )}
        {!history ? <LoadingState variant="table" className="text-sm muted">Loading invitation history…</LoadingState>
          : !history.data ? <ReadFailure error={history.error} onRetry={refresh} />
          : !history.data.invitations.length ? <p className="text-sm muted">No invitations for this student yet.</p>
          : (
            <ul className="divide-y divide-[var(--border)]">
              {history.data.invitations.map((invitation) => {
                const status = invitationStatus(invitation, history.data.checkedAt);
                return (
                  <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0 space-y-1 break-words">
                      <p className="text-sm font-semibold">{invitation.email || invitation.phone}</p>
                      <p className="text-sm muted">{status} · Expires {expiryFormat.format(Date.parse(invitation.expires_at))} IST</p>
                    </div>
                    {status === "Pending" && (
                      <button type="button" className={button} disabled={busy || Boolean(pendingRevoke)}
                        aria-label={`Revoke invitation for ${invitation.email || invitation.phone}`}
                        onClick={() => setPendingRevoke(invitation)}>Revoke</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </section>
    </>
  );
}
