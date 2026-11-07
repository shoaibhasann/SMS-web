"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw, Search, Users } from "lucide-react";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { loadGuardianDirectory, type GuardianDirectoryRecord } from "@/lib/guardian-invitations/directory";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";

type Client = ReturnType<typeof createClient>;
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60";
const message = (failure: unknown) => failure instanceof Error ? failure.message : "Guardian records could not be loaded. Retry or contact your school administrator.";

export function ParentDirectoryWorkspace({ userId }: { userId: string }) {
  return <ParentDirectory key={userId} userId={userId} />;
}

function ParentDirectory({ userId }: { userId: string }) {
  const [client] = useState(createClient), [access, setAccess] = useState<Access>();
  const [school, setSchool] = useState(""), [revision, setRevision] = useState(0), [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event !== "INITIAL_SESSION" && session?.user.id !== userId) { setChanged(true); setAccess(undefined); }
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);
  useEffect(() => {
    if (changed) return;
    let active = true;
    void loadSchoolManagementAccess(client, "the guardian directory", ["school_admin", "principal"]).then(value => {
      if (!active) return;
      if (value.userId !== userId) { setChanged(true); return; }
      setAccess(value); setError("");
    }, failure => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [changed, client, revision, userId]);
  const schoolId = school || (access?.schools.length === 1 ? access.schools[0].id : "");
  return <div className="space-y-6">
    <header><p className="text-xs font-bold uppercase tracking-widest text-[var(--primary)]">People</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Parents &amp; guardians</h1><p className="mt-2 text-sm leading-6 muted">School guardian records and their retained child links. Contact changes and invitations use the existing verified workflows.</p></header>
    {changed ? <p role="alert" className="card p-4 text-sm">Your account changed. Reopen this directory to verify access.</p>
      : error ? <div className="card space-y-3 p-4"><p role="alert" className="text-sm">{error}</p><button className={button} onClick={() => { setError(""); setRevision(value => value + 1); }}>Retry school access</button></div>
        : !access ? <LoadingState variant="form">Checking school access…</LoadingState>
          : <><label className="card block space-y-2 p-4 text-sm font-semibold"><span>School</span><select className="field" value={schoolId} disabled={access.schools.length === 1} onChange={event => setSchool(event.target.value)}><option value="">Select school</option>{access.schools.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            {schoolId ? <SchoolGuardians key={schoolId} client={client} userId={userId} schoolId={schoolId} canManage={access.schoolAdminIds.includes(schoolId)} /> : <p className="text-sm muted">Select an authorized school to view its guardians.</p>}
          </>}
  </div>;
}

function SchoolGuardians({ client, userId, schoolId, canManage }: { client: Client; userId: string; schoolId: string; canManage: boolean }) {
  const [records, setRecords] = useState<GuardianDirectoryRecord[]>(), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), [search, setSearch] = useState(""), [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadGuardianDirectory(client, userId, schoolId, controller.signal).then(value => {
      if (!controller.signal.aborted) { setRecords(value); setError(""); }
    }, failure => { if (!controller.signal.aborted) { setRecords(undefined); setError(message(failure)); } });
    return () => controller.abort();
  }, [client, revision, schoolId, userId]);
  const term = search.trim().toLocaleLowerCase();
  const filtered = records?.filter(record => !term || [record.name, record.code, record.mobile, ...record.children.flatMap(child => [child.name, child.admissionNumber])].join(" ").toLocaleLowerCase().includes(term)) ?? [];
  const pages = Math.ceil(filtered.length / 24), currentPage = Math.min(page, Math.max(0, pages - 1));
  return <section className="space-y-4" aria-label="School guardian directory">
    <div className="card flex flex-wrap items-center justify-between gap-4 p-4"><div><p className="flex items-center gap-2 text-sm font-semibold"><Users size={18} aria-hidden="true" />{records ? `${records.length} guardian records` : "School guardians"}</p><p className="mt-1 text-xs leading-5 muted">Read-only directory. Child links may include pupils who have withdrawn; review access through Guardian invitations.</p></div><div className="flex flex-wrap gap-2">{canManage && records && !error && <Link className={button} href="/modules/guardian-invitations">Manage guardian access</Link>}<button className={button} onClick={() => { setRecords(undefined); setError(""); setRevision(value => value + 1); }}><RefreshCw size={16} aria-hidden="true" />Refresh guardians</button></div></div>
    <label className="relative block"><span className="sr-only">Search guardians</span><Search size={17} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 muted" /><input className="field !pl-10" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Search guardian, mobile, child or admission number" /></label>
    {error ? <p role="alert" className="card p-4 text-sm">{error}</p> : !records ? <LoadingState variant="list">Loading school guardians…</LoadingState>
      : !filtered.length ? <p className="card p-5 text-sm muted">{records.length ? "No guardians match this search." : "No guardian records are linked to this school yet."}</p>
        : <div className="grid items-start gap-4 xl:grid-cols-2">{filtered.slice(currentPage * 24, (currentPage + 1) * 24).map(record => <article key={record.id} className="card min-w-0 space-y-4 p-5"><header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-base font-semibold">{record.name?.trim() || record.code || "Guardian without a recorded name"}</h2>{record.code && <p className="mt-1 break-all text-xs muted">{record.code}</p>}</div><span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-semibold">{record.account === "active" ? "Active school profile" : record.account === "inactive" ? "Inactive school profile" : "No linked profile"}</span></header>
          <p className="break-all text-sm muted">School registered mobile: <span className="font-medium text-[var(--text)]">{record.mobile || "Not recorded"}</span></p>
          <div className="space-y-2"><h3 className="text-sm font-semibold">{record.children.length} linked {record.children.length === 1 ? "child" : "children"}</h3>{record.children.length ? <ul className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-xl border border-[var(--border)] px-3" tabIndex={0} aria-label={`Linked children for ${record.name || record.code || "guardian"}`}>{record.children.map(child => <li key={child.id} className="space-y-1 break-words py-3 text-sm"><p className="font-semibold">{child.name}</p><p className="break-all text-xs muted">{child.admissionNumber} · {child.status}</p><p className="text-xs muted">{child.relationship.trim() || "Relationship not recorded"}{child.primary ? " · Primary contact" : ""}</p></li>)}</ul> : <p className="text-sm leading-6 muted">No current child links. Use the school invitation and access workflow to review access.</p>}</div>
        </article>)}</div>}
    {!!records && pages > 1 && <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Guardian directory pages"><p className="text-sm muted">Page {currentPage + 1} of {pages} · {filtered.length} matching guardians</p><div className="flex gap-2"><button className={button} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous guardians</button><button className={button} disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next guardians</button></div></nav>}
  </section>;
}
