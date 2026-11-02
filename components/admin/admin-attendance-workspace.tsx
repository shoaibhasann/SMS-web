"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, RefreshCw, Search } from "lucide-react";
import { AdminDemoService, type AdminDemoRecord } from "@/lib/admin/admin-demo-service";

const statuses = ["Present", "Absent", "Leave", "Holiday"];

export function AdminAttendanceWorkspace() {
  const [records, setRecords] = useState<AdminDemoRecord[]>([]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [classFilter, setClassFilter] = useState("All");
  const [sectionFilter, setSectionFilter] = useState("All");
  const [studentFilter, setStudentFilter] = useState("");

  useEffect(() => {
    setRecords(AdminDemoService.load("attendance"));
  }, []);

  const classes = [...new Set(records.map((record) => String(record.className)))];
  const sections = [...new Set(records.filter((record) => classFilter === "All" || record.className === classFilter).map((record) => String(record.section)))];
  const filtered = useMemo(() => records.filter((record) =>
    record.date === date &&
    (classFilter === "All" || record.className === classFilter) &&
    (sectionFilter === "All" || record.section === sectionFilter) &&
    String(record.student).toLocaleLowerCase().includes(studentFilter.trim().toLocaleLowerCase()),
  ), [records, date, classFilter, sectionFilter, studentFilter]);
  const count = (status: string) => filtered.filter((record) => record.status === status).length;
  const marked = filtered.filter((record) => statuses.slice(0, 3).includes(String(record.status))).length;
  const rate = marked ? Math.round((count("Present") / marked) * 100) : 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-widest text-blue-600">School Administration</p><h1 className="mt-1 text-3xl font-black">Attendance</h1><p className="mt-2 text-sm muted">School-wide attendance preview with date, class, section, and student filters.</p></div>
        <button type="button" onClick={() => setRecords(AdminDemoService.load("attendance"))} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold"><RefreshCw size={16} /> Reset demo data</button>
      </header>
      <div className="rounded-xl border border-sky-300/50 bg-sky-500/5 px-4 py-3 text-xs leading-5 text-sky-800 dark:text-sky-200">Demo attendance preview: records shown here are local sample data. The existing Teacher Attendance register is unchanged.</div>
      <section className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1.5 text-sm font-medium">Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="field" /></label>
        <label className="space-y-1.5 text-sm font-medium">Class<select value={classFilter} onChange={(event) => { setClassFilter(event.target.value); setSectionFilter("All"); }} className="field"><option>All</option>{classes.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="space-y-1.5 text-sm font-medium">Section<select value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)} className="field"><option>All</option>{sections.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="relative space-y-1.5 text-sm font-medium">Student<span className="relative block"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 muted" /><input value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)} placeholder="Search student" className="field pl-9" /></span></label>
      </section>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Present", count("Present")], ["Absent", count("Absent")], ["Leave", count("Leave")],
          ["Holiday", count("Holiday")], ["Attendance", `${rate}%`],
        ].map(([label, value]) => <article key={String(label)} className="card p-4"><p className="text-xs font-semibold muted">{label}</p><p className="mt-2 text-2xl font-black">{value}</p></article>)}
      </section>
      <section className="card overflow-hidden">
        <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="flex items-center gap-2 font-bold"><CalendarCheck size={18} />Attendance register</h2></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Roll No.</th><th className="p-3">Class</th><th className="p-3">Section</th><th className="p-3">Date</th><th className="p-3">Status</th></tr></thead>
          <tbody className="divide-y divide-[var(--border)]">{filtered.map((record) => <tr key={record.id}><td className="p-3 font-semibold">{String(record.student)}</td><td className="p-3">{String(record.rollNo)}</td><td className="p-3">{String(record.className)}</td><td className="p-3">{String(record.section)}</td><td className="p-3">{String(record.date)}</td><td className="p-3"><span className="rounded-full bg-blue-500/10 px-2.5 py-1 text-xs font-semibold">{String(record.status)}</span></td></tr>)}
            {!filtered.length && <tr><td className="p-6 text-center muted" colSpan={6}>No attendance entries match these filters.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}
