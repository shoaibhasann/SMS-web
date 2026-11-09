"use client";

import { demoStats } from "@/lib/dashboard-data";

type DashboardRole = keyof typeof demoStats;

const headings: Record<DashboardRole, string> = {
  admin: "School Admin Dashboard",
  teacher: "Teacher Dashboard",
  student: "Student Dashboard",
  parent: "Parent Dashboard",
  finance: "Finance Dashboard",
};

export function Dashboard({ role }: { role: DashboardRole }) {
  return (
    <div className="space-y-6">
      <header className="gradient rounded-[28px] p-6 text-white sm:p-8">
        <p className="text-xs font-bold uppercase tracking-widest text-white/70">SMS</p>
        <h1 className="mt-2 text-3xl font-black">{headings[role]}</h1>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {demoStats[role].map(([label, value, context]) => (
          <article key={label} className="card p-5">
            <p className="text-sm font-semibold muted">{label}</p>
            <p className="mt-2 text-3xl font-black">{value}</p>
            <p className="mt-1 text-xs muted">{context}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
