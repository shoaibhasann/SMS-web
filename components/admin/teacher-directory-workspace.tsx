"use client";

import Link from "next/link";
import { BadgeCheck, Clipboard, GraduationCap, Link2, UserRoundPlus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { StaffCsvImport } from "@/components/admin/staff-csv-import";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { invitationStatus, type SchoolInvitation } from "@/lib/invitations/model";
import { createClient } from "@/lib/supabase/client";
import { createTeacherRecord, issueTeacherInvitation, listNonTeachingStaff, listTeacherInvitations, listTeachers, revokeTeacherInvitation, type NonTeachingStaffRecord, type TeacherRecord } from "@/lib/teachers/directory";
import { LoadingState } from "@/components/ui/skeleton";

type Client = ReturnType<typeof createClient>;
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
type Result<T> = { data: T } | { error: string };
type Feedback = { text: string; error?: boolean };

const label = "block space-y-2 text-sm font-semibold";
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60";
const primary = button + " bg-blue-700 text-white hover:bg-blue-800";
const dateLabel = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
});

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function TeacherDirectoryWorkspace({ userId }: { userId: string }) {
  const [client] = useState(createClient);
  const [access, setAccess] = useState<Result<Access>>();
  const [school, setSchool] = useState("");
  const [sessionChanged, setSessionChanged] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);

  useEffect(() => {
    if (sessionChanged) return;
    let active = true;
    loadSchoolManagementAccess(client, "teacher accounts", ["school_admin", "principal"]).then((data) => {
      if (!active) return;
      if (data.userId !== userId) setSessionChanged(true);
      else setAccess({ data });
    }, (error: unknown) => {
      if (active) setAccess({ error: message(error, "School access could not be loaded.") });
    });
    return () => { active = false; };
  }, [client, userId, sessionChanged]);

  const schools = access && "data" in access ? access.data.schools : [];
  const schoolId = school || (schools.length === 1 ? schools[0].id : "");

  return (
    <div className="space-y-5">
      <header className="gradient flex flex-wrap items-center gap-4 rounded-[28px] p-5 text-white sm:p-7">
        <span className="grid size-12 place-items-center rounded-2xl bg-white/15"><GraduationCap aria-hidden="true" /></span>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-white/80">People</p>
          <h1 className="text-2xl font-black sm:text-3xl">Teachers &amp; Staff</h1>
          <p className="mt-1 text-sm text-white/85">Manage the school’s teachers and non-teaching staff. Teachers can link a verified school login by invitation.</p>
        </div>
      </header>
      {sessionChanged ? <p role="alert" className="card p-4 text-sm">Your account changed. Reload the page to check school access.</p>
        : !access ? <LoadingState variant="form" className="text-sm muted">Checking school access…</LoadingState>
        : "error" in access ? <p role="alert" className="card p-4 text-sm">{access.error}</p>
        : <>
          <label className={`card p-4 ${label}`}>
            <span>School</span>
            <select className="field" value={schoolId} disabled={busy || schools.length === 1}
              onChange={(event) => setSchool(event.target.value)}>
              <option value="">Select school</option>
              {schools.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {schoolId
            ? <SchoolDirectory key={schoolId} client={client} schoolId={schoolId} busy={busy} setBusy={setBusy} />
            : <p className="text-sm muted">Select a school to open its teacher directory.</p>}
        </>}
    </div>
  );
}

function SchoolDirectory({ client, schoolId, busy, setBusy }: {
  client: Client; schoolId: string; busy: boolean; setBusy: (busy: boolean) => void;
}) {
  const [directory, setDirectory] = useState<{
    version: number;
    teachers: Result<TeacherRecord[]>;
    staff: Result<NonTeachingStaffRecord[]>;
  }>();
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [fullName, setFullName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [filter, setFilter] = useState("");
  const [staffFilter, setStaffFilter] = useState("");
  const [feedback, setFeedback] = useState<Feedback>();
  const creating = useRef(false);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([listTeachers(client, schoolId), listNonTeachingStaff(client, schoolId)]).then(([teachers, staff]) => {
      if (!active) return;
      setDirectory({
        version,
        teachers: teachers.status === "fulfilled" ? { data: teachers.value } : { error: "The teacher directory could not be loaded." },
        staff: staff.status === "fulfilled" ? { data: staff.value } : { error: "The staff directory could not be loaded." },
      });
    });
    return () => { active = false; };
  }, [client, schoolId, version]);

  async function addTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || creating.current || !fullName.trim() || !employeeId.trim()) return;
    creating.current = true;
    setBusy(true);
    setFeedback(undefined);
    try {
      const id = await createTeacherRecord(client, schoolId, employeeId, fullName);
      setSelectedId(id);
      setFullName("");
      setEmployeeId("");
      setFilter("");
      setFeedback({ text: "Teacher added. Create their invitation when ready." });
      setVersion((value) => value + 1);
    } catch (error) {
      setFeedback({ text: message(error, "The teacher could not be added."), error: true });
    } finally {
      setBusy(false);
      creating.current = false;
    }
  }

  const result = directory?.teachers;
  const staffResult = directory?.staff;
  const teachers = result && "data" in result ? result.data : [];
  const staff = staffResult && "data" in staffResult ? staffResult.data : [];
  const existingEmployeeIds = directory?.version === version && result && "data" in result && staffResult && "data" in staffResult
    ? [...teachers.map((person) => person.employee_id), ...staff.map((person) => person.employee_id)]
    : undefined;
  const staffSearch = staffFilter.trim().toLowerCase();
  const visibleStaff = staff.filter((person) =>
    `${person.full_name ?? ""} ${person.employee_id}`.toLowerCase().includes(staffSearch),
  );
  const selected = teachers.find((teacher) => teacher.id === selectedId);
  const search = filter.trim().toLowerCase();
  const visibleTeachers = teachers.filter((teacher) =>
    `${teacher.full_name ?? ""} ${teacher.employee_id}`.toLowerCase().includes(search),
  );

  return (
    <>
      <form className="card space-y-4 p-4 sm:p-5" onSubmit={(event) => void addTeacher(event)}>
        <h2 className="text-lg font-bold">Add a teacher</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={label}><span>Full name</span><input className="field" required maxLength={160}
            autoComplete="off" value={fullName} disabled={busy} onChange={(event) => setFullName(event.target.value)} /></label>
          <label className={label}><span>Employee ID</span><input className="field" required maxLength={64}
            autoComplete="off" value={employeeId} disabled={busy} onChange={(event) => setEmployeeId(event.target.value)} /></label>
        </div>
        <button className={primary} type="submit" disabled={busy || !fullName.trim() || !employeeId.trim()}>
          <UserRoundPlus size={17} aria-hidden="true" /> Add teacher
        </button>
        {feedback && <p role={feedback.error ? "alert" : "status"} className="text-sm">{feedback.text}</p>}
      </form>
      <StaffCsvImport client={client} schoolId={schoolId} existingEmployeeIds={existingEmployeeIds}
        disabled={busy} refreshVersion={version} onBusyChange={setBusy} onImported={() => {
          setFilter("");
          setStaffFilter("");
          setVersion((value) => value + 1);
        }} />
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="card space-y-4 p-4 sm:p-5" aria-labelledby="teacher-list-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold" id="teacher-list-heading">Teacher directory</h2>
            <button className={button} type="button" disabled={busy} onClick={() => setVersion((value) => value + 1)}>
              Refresh directory
            </button>
          </div>
          <label className={label}><span>Search teachers</span><input className="field" type="search" value={filter}
            onChange={(event) => setFilter(event.target.value)} /></label>
          {!result ? <LoadingState variant="list" className="text-sm muted">Loading teachers…</LoadingState>
            : "error" in result ? <p role="alert" className="text-sm">{result.error}</p>
            : visibleTeachers.length === 0 ? <p className="text-sm muted">{search ? "No matching teachers." : "No teachers have been added to this school."}</p>
            : <ul className="divide-y divide-[var(--border)]">
              {visibleTeachers.map((teacher) => (
                <li key={teacher.id}>
                  <button type="button" aria-pressed={teacher.id === selectedId} disabled={busy}
                    onClick={() => setSelectedId(teacher.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left aria-pressed:bg-blue-500/10 hover:bg-[var(--surface-2)]">
                    <span className="min-w-0 break-words">
                      <strong className="block text-sm">{teacher.full_name || teacher.employee_id}</strong>
                      <span className="text-xs muted">{teacher.employee_id}</span>
                    </span>
                    <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-1 text-xs">
                      {teacher.profile_id ? "Linked" : "Awaiting link"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>}
        </section>
        {selected
          ? <TeacherInvitationPanel key={selected.id} teacher={selected} client={client} busy={busy} setBusy={setBusy} refreshVersion={version} />
          : <section className="card grid min-h-40 place-content-center p-5 text-center">
              <Link2 className="mx-auto mb-2 muted" aria-hidden="true" />
              <p className="text-sm muted">Select a teacher to manage their invitation.</p>
            </section>}
      </div>
      <section className="card space-y-4 p-4 sm:p-5" aria-labelledby="staff-list-heading">
        <h2 className="text-lg font-bold" id="staff-list-heading">Non-teaching staff directory</h2>
        <label className={label}><span>Search staff</span><input className="field" type="search" value={staffFilter}
          onChange={(event) => setStaffFilter(event.target.value)} /></label>
        {!staffResult ? <LoadingState variant="list" className="text-sm muted">Loading staff…</LoadingState>
          : "error" in staffResult ? <p role="alert" className="text-sm">{staffResult.error}</p>
          : !visibleStaff.length ? <p className="text-sm muted">{staffSearch ? "No matching staff." : "No non-teaching staff have been added to this school."}</p>
          : <ul className="divide-y divide-[var(--border)]">
              {visibleStaff.map((person) => (
                <li key={person.id} className="flex flex-wrap items-center justify-between gap-2 break-words py-3 text-sm">
                  <div className="min-w-0">
                    <strong className="block">{person.full_name || person.employee_id}</strong>
                    <span className="muted">{person.employee_id}</span>
                  </div>
                  {(person.designation || person.department) && <span className="muted">
                    {[person.designation, person.department].filter(Boolean).join(" · ")}
                  </span>}
                </li>
              ))}
            </ul>}
      </section>
    </>
  );
}

function TeacherInvitationPanel({ teacher, client, busy, setBusy, refreshVersion }: {
  teacher: TeacherRecord; client: Client; busy: boolean; setBusy: (busy: boolean) => void; refreshVersion: number;
}) {
  const [result, setResult] = useState<Result<{ items: SchoolInvitation[]; now: number }>>();
  const [version, setVersion] = useState(0);
  const [email, setEmail] = useState("");
  const [share, setShare] = useState<{ id: string; url: string; expires: string }>();
  const [feedback, setFeedback] = useState<Feedback>();
  const actionInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    listTeacherInvitations(client, teacher.id).then(
      (items) => { if (active) setResult({ data: { items, now: Date.now() } }); },
      (error: unknown) => { if (active) setResult({ error: message(error, "The invitation history could not be loaded.") }); },
    );
    return () => { active = false; };
  }, [client, teacher.id, version, refreshVersion]);

  async function updateInvitation(action: () => Promise<void>) {
    if (busy || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setFeedback(undefined);
    try {
      await action();
      setVersion((value) => value + 1);
    } catch (error) {
      setFeedback({ text: message(error, "The invitation could not be updated."), error: true });
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || teacher.profile_id) return;
    void updateInvitation(async () => {
      const invitation = await issueTeacherInvitation(client, teacher.id, email.trim());
      const url = new URL("/teacher-invite", window.location.origin);
      url.hash = `token=${invitation.token}`;
      setShare({ id: invitation.id, url: url.toString(), expires: invitation.expires_at });
      setEmail("");
      setFeedback({ text: "Invitation ready. Share the link privately with the invited teacher." });
    });
  }

  async function copyInvitation() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setFeedback({ text: "Invitation link copied." });
    } catch {
      setFeedback({ text: "Copy the link directly from the field below.", error: true });
    }
  }

  const history = result && "data" in result ? result.data : undefined;
  const pending = history?.items.some((invitation) => invitationStatus(invitation, history.now) === "Pending");

  return (
    <section className="card space-y-4 p-4 sm:p-5" aria-labelledby="teacher-invite-heading">
      <header>
        <h2 className="text-lg font-bold" id="teacher-invite-heading">Teacher invitation</h2>
        <p className="mt-1 text-sm muted">{teacher.full_name || teacher.employee_id} · {teacher.employee_id}</p>
      </header>
      {teacher.profile_id
        ? <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <BadgeCheck size={18} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
            <span className="font-semibold">Account linked</span>
            <Link className="font-semibold text-blue-700 underline dark:text-blue-300" href="/modules/teacher-assignments">Manage teaching assignments</Link>
          </div>
        : <form className="space-y-3" onSubmit={issue}>
            <label className={label}><span>Teacher email</span><input className="field" type="email" required maxLength={254}
              disabled={busy} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <p className="text-xs muted">The link expires in 72 hours and requires this verified email. A replacement cancels the previous pending link.</p>
            <button className={primary} type="submit" disabled={busy || !email.trim()}>
              <Link2 size={17} aria-hidden="true" /> {pending ? "Create replacement link" : "Create teacher invitation"}
            </button>
          </form>}
      {feedback && <p role={feedback.error ? "alert" : "status"} className="text-sm">{feedback.text}</p>}
      {share && !teacher.profile_id && (
        <div className="space-y-3 rounded-xl border border-blue-500/30 bg-blue-500/5 p-3">
          <label className={label}><span>Invitation link</span>
            <input className="field" readOnly value={share.url} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <p className="text-xs muted">Expires {dateLabel.format(new Date(share.expires))} IST.</p>
          <button type="button" className={button} onClick={() => void copyInvitation()}>
            <Clipboard size={16} aria-hidden="true" /> Copy invitation link
          </button>
        </div>
      )}
      <div className="space-y-2 border-t border-[var(--border)] pt-4">
        <h3 className="text-sm font-semibold">Invitation history</h3>
        {!result ? <LoadingState variant="list" className="text-sm muted">Loading invitations…</LoadingState>
          : "error" in result ? <p role="alert" className="text-sm">{result.error}</p>
          : result.data.items.length === 0 ? <p className="text-sm muted">No invitations have been created for this teacher.</p>
          : <ul className="divide-y divide-[var(--border)]">
            {result.data.items.map((invitation) => {
              const status = invitationStatus(invitation, result.data.now);
              return (
                <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0 break-words">
                    <p className="text-sm font-semibold">{invitation.email}</p>
                    <p className="text-xs muted">{status} · {dateLabel.format(new Date(invitation.expires_at))} IST</p>
                  </div>
                  {status === "Pending" && <button className={button} type="button" disabled={busy}
                    onClick={() => void updateInvitation(async () => {
                      const revoked = await revokeTeacherInvitation(client, invitation.id);
                      if (share?.id === invitation.id) setShare(undefined);
                      setFeedback({ text: revoked ? "Invitation revoked." : "The invitation was already closed." });
                    })}>Revoke invitation</button>}
                </li>
              );
            })}
          </ul>}
      </div>
    </section>
  );
}
