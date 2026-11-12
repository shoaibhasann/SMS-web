"use client";

import Link from "next/link";
import { ArrowLeft, CircleHelp } from "lucide-react";

export function AdminModulePlaceholder({ moduleName }: { moduleName: string }) {
  const title = moduleName
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--primary)]">School Administration</p>
        <h1 className="mt-1 text-3xl font-black">{title}</h1>
      </header>
      <section className="card p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--surface-2)] text-[var(--primary)]">
            <CircleHelp size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold">Coming soon</h2>
            <p className="mt-2 text-sm leading-6 muted">
              This module is being prepared for your school administration workspace.
            </p>
          </div>
        </div>
        <Link href="/dashboard" className="mt-6 inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold transition hover:bg-[var(--surface-2)]">
          <ArrowLeft size={16} /> Return to Dashboard
        </Link>
      </section>
    </div>
  );
}
