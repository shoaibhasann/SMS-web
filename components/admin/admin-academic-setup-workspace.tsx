"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { addAcademicSetupRecord, loadAcademicSetup, type AcademicSetup, type AcademicSetupDraft } from "@/lib/admin/academic-setup";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { createClient } from "@/lib/supabase/client";

const tabs = [
  { key: "years", label: "Academic years", name: "academic year" },
  { key: "classes", label: "Classes", name: "class" },
  { key: "sections", label: "Sections", name: "section" },
  { key: "subjects", label: "Subjects", name: "subject" },
] as const;

type Client = ReturnType<typeof createClient>;
type SchoolAccess = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;

export function AdminAcademicSetupWorkspace({ userId }: { userId: string }) {
  const [client] = useState(createClient);
  const [access, setAccess] = useState<SchoolAccess>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [chosenSchool, setChosenSchool] = useState("");
  const [saving, setSaving] = useState(false);
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
    loadSchoolManagementAccess(client, "academic setup", ["school_admin", "principal"]).then((result) => {
      if (!active) return;
      if (result.userId !== userId) setError("Your sign-in changed. Refresh to check access.");
      else setAccess(result);
    }, () => { if (active) setError("Could not load your schools. Sign in again or retry."); });
    return () => { active = false; };
  }, [attempt, client, sessionChanged, userId]);

  const school = access?.schools.find((item) => item.id === chosenSchool)
    ?? (access?.schools.length === 1 ? access.schools[0] : undefined);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-600">Academics · Configuration</p>
        <h1 className="mt-1 text-3xl font-black">Academics &amp; Subjects</h1>
        <p className="mt-2 text-sm muted">Set up the academic years, classes, sections and subjects used by enrollment and attendance.</p>
      </header>
      {sessionChanged ? <p role="alert" className="text-sm text-red-600">Your sign-in changed. Refresh to check access.</p> : error ? (
        <section className="card space-y-3 p-4">
          <p role="alert" className="text-sm text-red-600">{error}</p>
          <button type="button" className="text-sm font-semibold text-blue-600" onClick={() => {
            setError("");
            setAttempt((count) => count + 1);
          }}>Retry school access</button>
        </section>
      ) : !access ? <p role="status" className="text-sm muted">Checking school access…</p>
        : (
          <>
            <label className="card block space-y-2 p-4 text-sm font-semibold">
              <span>School</span>
              <select className="field" value={school?.id ?? ""} disabled={saving || access.schools.length === 1}
                onChange={(event) => setChosenSchool(event.target.value)}>
                <option value="">Select school</option>
                {access.schools.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            {school && (
              <SchoolAcademicSetup key={school.id} client={client} schoolId={school.id} userId={userId}
                saving={saving} setSaving={setSaving} />
            )}
          </>
        )}
    </div>
  );
}

function SchoolAcademicSetup({ client, schoolId, userId, saving, setSaving }: {
  client: Client;
  schoolId: string;
  userId: string;
  saving: boolean;
  setSaving: (value: boolean) => void;
}) {
  const [selectedTab, setSelectedTab] = useState<(typeof tabs)[number]>(tabs[0]);
  const [setup, setSetup] = useState<AcademicSetup>();
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    loadAcademicSetup(client, schoolId).then((data) => {
      if (active) setSetup(data);
    }, () => { if (active) setNotice({ text: "Could not load school records. Refresh to try again.", error: true }); });
    return () => { active = false; };
  }, [attempt, client, schoolId]);

  const activeClasses = setup?.classes.filter((item) => item.is_active) ?? [];

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup || inFlight.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const value = (key: string) => String(fields.get(key) ?? "");
    const name = value("name");
    const kind = selectedTab.key;
    let draft: AcademicSetupDraft;
    switch (kind) {
      case "years":
        draft = { kind, name, startDate: value("startDate"), endDate: value("endDate"), firstYear: setup.years.length === 0 };
        break;
      case "classes":
        draft = { kind, name, sortOrder: Number(value("sortOrder")) };
        break;
      case "sections":
        if (!activeClasses.some((item) => item.id === value("classId"))) {
          setNotice({ text: "Choose an active class for this section.", error: true });
          return;
        }
        draft = { kind, name, classId: value("classId") };
        break;
      case "subjects":
        draft = { kind, name, code: value("code") };
        break;
    }
    inFlight.current = true;
    setSaving(true);
    setNotice(undefined);
    try {
      const { data, error } = await client.auth.getUser();
      if (error || data.user?.id !== userId) throw new Error("Your sign-in changed. Refresh to check access.");
      await addAcademicSetupRecord(client, schoolId, draft);
      form.reset();
      setNotice({ text: "Saved to the school." });
      setSetup(undefined);
      setAttempt((count) => count + 1);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Could not save the record.", error: true });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const rows = setup?.[selectedTab.key] ?? [];
  return (
    <section className="card space-y-4 p-4 sm:p-6" aria-label="School academic setup">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" aria-label="Record type">
          {tabs.map((tab) => (
            <button key={tab.key} type="button" aria-pressed={selectedTab.key === tab.key} disabled={saving}
              className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold aria-pressed:bg-blue-700 aria-pressed:text-white disabled:opacity-60"
              onClick={() => { setSelectedTab(tab); if (setup) setNotice(undefined); }}>{tab.label}</button>
          ))}
        </div>
        <button type="button" disabled={saving} onClick={() => {
          setNotice(undefined);
          setSetup(undefined);
          setAttempt((count) => count + 1);
        }} className="text-sm font-semibold text-blue-600">Refresh records</button>
      </div>
      {notice && <p role={notice.error ? "alert" : "status"} className={`text-sm ${notice.error ? "text-red-600" : "text-emerald-600"}`}>{notice.text}</p>}
      {!setup ? (!notice?.error && <p role="status" className="text-sm muted">Loading school records…</p>) : (
        <>
          <h2 className="font-bold">{selectedTab.label}</h2>
          {rows.length ? (
            <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <strong>{row.name}</strong>
                  <span className="muted">
                    {"start_date" in row && `${row.start_date} to ${row.end_date}${row.is_current ? " · Current" : ""}`}
                    {"sort_order" in row && `Order ${row.sort_order}${row.is_active ? "" : " · Inactive"}`}
                    {"class_id" in row && (setup.classes.find((item) => item.id === row.class_id)?.name ?? "Class unavailable")}
                    {"code" in row && [row.code, row.is_active ? "" : "Inactive"].filter(Boolean).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm muted">No records yet.</p>}
          {selectedTab.key === "sections" && !activeClasses.length
            ? <p className="text-sm muted">Add a class first to create a section.</p>
            : (
              <form key={selectedTab.key} onSubmit={save}>
                <fieldset disabled={saving} className="grid items-end gap-3 sm:grid-cols-2">
                  <legend className="mb-2 font-bold">Add {selectedTab.name}</legend>
                  <label className="block space-y-1 text-sm font-semibold">
                    <span>Name</span><input required maxLength={100} name="name" className="field" />
                  </label>
                  {selectedTab.key === "years" && (
                    <>
                      <label className="block space-y-1 text-sm font-semibold"><span>Start date</span><input required type="date" name="startDate" className="field" /></label>
                      <label className="block space-y-1 text-sm font-semibold"><span>End date</span><input required type="date" name="endDate" className="field" /></label>
                      <p className="text-sm muted">{setup.years.length ? "This year will be saved without changing the current year." : "This first academic year will be set as current."}</p>
                    </>
                  )}
                  {selectedTab.key === "classes" && (
                    <label className="block space-y-1 text-sm font-semibold"><span>Display order</span><input required type="number" name="sortOrder" defaultValue={0} min={0} max={999} className="field" /></label>
                  )}
                  {selectedTab.key === "sections" && (
                    <label className="block space-y-1 text-sm font-semibold"><span>Class</span><select required name="classId" defaultValue="" className="field">
                      <option value="">Select class</option>
                      {activeClasses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select></label>
                  )}
                  {selectedTab.key === "subjects" && (
                    <label className="block space-y-1 text-sm font-semibold"><span>Subject code (optional)</span><input name="code" maxLength={30} className="field" /></label>
                  )}
                  <div className="sm:col-span-2">
                    <button type="submit" className="rounded-xl bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
                      {saving ? "Saving…" : `Add ${selectedTab.name}`}
                    </button>
                  </div>
                </fieldset>
              </form>
            )}
        </>
      )}
    </section>
  );
}
