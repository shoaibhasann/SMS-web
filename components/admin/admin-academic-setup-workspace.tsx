"use client";

import { FormEvent, useMemo, useState } from "react";
import { BookOpen, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AdminDemoService, type AdminDemoRecord } from "@/lib/admin/admin-demo-service";
import { useAdminDemoRecords } from "./admin-demo-workspace";

type AcademicTab = "Academic Year" | "Class" | "Section" | "Subject";
const tabs: AcademicTab[] = ["Academic Year", "Class", "Section", "Subject"];
const fields: Record<AcademicTab, { key: string; label: string; type?: string }[]> = {
  "Academic Year": [{ key: "name", label: "Academic Year" }, { key: "startDate", label: "Start Date", type: "date" }, { key: "endDate", label: "End Date", type: "date" }],
  Class: [{ key: "name", label: "Class Name" }, { key: "sortOrder", label: "Display Order", type: "number" }],
  Section: [{ key: "name", label: "Section Name" }, { key: "className", label: "Class" }],
  Subject: [{ key: "name", label: "Subject Name" }, { key: "code", label: "Subject Code" }],
};

export function AdminAcademicSetupWorkspace() {
  const [records, refreshRecords] = useAdminDemoRecords("academics");
  const [tab, setTab] = useState<AcademicTab>("Academic Year");
  const [editing, setEditing] = useState<AdminDemoRecord | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [toast, setToast] = useState("");

  const load = refreshRecords;

  const visible = useMemo(() => records.filter((record) => record.recordType === tab), [records, tab]);
  function openForm(record?: AdminDemoRecord) {
    setEditing(record ?? null);
    setForm(Object.fromEntries(fields[tab].map(({ key }) => [key, record ? String(record[key] ?? "") : ""])));
    setModalOpen(true);
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const updated = editing
      ? records.map((record) => record.id === editing.id ? { ...record, ...form } : record)
      : [...records, {
        id: `${tab.toLowerCase().replaceAll(" ", "-")}-demo-${Date.now()}`,
        recordType: tab,
        ...form,
        status: "Active",
        ...(tab === "Academic Year" ? { current: false } : {}),
        ...(tab === "Subject" ? { practical: false } : {}),
      }];
    AdminDemoService.save("academics", updated);
    refreshRecords();
    setModalOpen(false);
    setToast(editing ? `${tab} updated in demo data.` : `${tab} added to demo data.`);
  }
  function remove(record: AdminDemoRecord) {
    if (!window.confirm(`Delete “${record.name}” from demo data?`)) return;
    const updated = records.filter((item) => item.id !== record.id);
    AdminDemoService.save("academics", updated);
    refreshRecords();
  }
  function makeCurrent(record: AdminDemoRecord) {
    const updated = records.map((item) => item.recordType === "Academic Year"
      ? { ...item, current: item.id === record.id, status: item.id === record.id ? "Active" : "Inactive" }
      : item);
    AdminDemoService.save("academics", updated);
    refreshRecords();
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-widest text-blue-600">Academics · Configuration</p><h1 className="mt-1 text-3xl font-black">Academics &amp; Subjects</h1><p className="mt-2 text-sm muted">Manage academic years, classes, sections, and subjects.</p></div>
        <button type="button" onClick={load} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold"><RefreshCw size={16} /> Reset demo data</button>
      </header>
      <div className="rounded-xl border border-sky-300/50 bg-sky-500/5 px-4 py-3 text-xs leading-5 text-sky-800 dark:text-sky-200">Demo preview: changes are saved in this browser only.</div>
      {toast && <p role="status" className="text-sm text-emerald-600">{toast}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{tabs.map((item) => <button key={item} type="button" onClick={() => setTab(item)} className={`card p-4 text-left ${tab === item ? "border-blue-500 ring-2 ring-blue-500/15" : ""}`}><div className="flex items-center justify-between"><span className="text-sm font-semibold muted">{item === "Academic Year" ? "Academic Years" : `${item}s`}</span><BookOpen size={17} className="text-blue-600" /></div><p className="mt-2 text-2xl font-black">{records.filter((record) => record.recordType === item).length}</p></button>)}</div>
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4"><div className="flex flex-wrap gap-2" role="tablist" aria-label="Academic master data">{tabs.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={`rounded-xl px-3 py-2 text-sm font-semibold ${tab === item ? "bg-blue-600 text-white" : "border border-[var(--border)]"}`}>{item === "Academic Year" ? "Academic Years" : `${item}s`}</button>)}</div><button type="button" onClick={() => openForm()} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white"><Plus size={16} /> Add {tab}</button></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr>{fields[tab].map((field) => <th key={field.key} className="p-3">{field.label}</th>)}<th className="p-3">Status</th><th className="p-3 text-right">Actions</th></tr></thead><tbody className="divide-y divide-[var(--border)]">{visible.map((record) => <tr key={record.id}>{fields[tab].map(({ key }) => <td key={key} className="p-3">{String(record[key] ?? "—")}</td>)}<td className="p-3">{tab === "Academic Year" && record.current ? "Current" : String(record.status ?? "Active")}</td><td className="p-3"><div className="flex justify-end gap-1">{tab === "Academic Year" && !record.current && <button type="button" onClick={() => makeCurrent(record)} className="rounded-lg px-2 text-xs font-semibold text-blue-600">Set current</button>}<button type="button" onClick={() => openForm(record)} aria-label="Edit record" className="rounded-lg p-2"><Pencil size={15} /></button><button type="button" onClick={() => remove(record)} aria-label="Delete record" className="rounded-lg p-2 text-red-600"><Trash2 size={15} /></button></div></td></tr>)}{!visible.length && <tr><td colSpan={fields[tab].length + 2} className="p-6 text-center muted">No records available yet.</td></tr>}</tbody></table></div>
      </section>
      {modalOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"><form onSubmit={save} className="w-full max-w-lg space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"><div><h2 className="text-lg font-bold">{editing ? `Edit ${tab}` : `Add ${tab}`}</h2><p className="text-sm muted">Saved to this browser’s demo data.</p></div>{fields[tab].map(({ key, label, type }) => <label key={key} className="block space-y-1.5 text-sm font-medium">{label}<input required value={form[key] ?? ""} type={type ?? "text"} onChange={(event) => setForm((value) => ({ ...value, [key]: event.target.value }))} className="field" /></label>)}{tab === "Subject" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.practical === "true"} onChange={(event) => setForm((value) => ({ ...value, practical: String(event.target.checked) }))} /> Practical subject</label>}<div className="flex justify-end gap-2"><button type="button" onClick={() => setModalOpen(false)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button><button className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">{editing ? "Save changes" : "Add to demo data"}</button></div></form></div>}
    </div>
  );
}
