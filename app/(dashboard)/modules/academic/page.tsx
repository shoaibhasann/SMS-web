"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  CalendarDays,
  GraduationCap,
  Layers3,
  Plus,
  RefreshCw,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type AcademicYear = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
};

type SchoolClass = {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
};

type Section = {
  id: string;
  class_id: string;
  name: string;
};

type Subject = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  is_practical: boolean;
  is_active: boolean;
};

type Stream = {
  id: string;
  name: string;
};

export default function AcademicSetupPage() {
  const supabase = createClient();

  const [schoolId, setSchoolId] = useState<string | null>(null);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingSubject, setSavingSubject] = useState(false);
  const [message, setMessage] = useState("");

  const [subjectForm, setSubjectForm] = useState({
    code: "",
    name: "",
    practical: false,
  });

  async function load() {
    setLoading(true);
    setMessage("");

    const { data: auth } = await supabase.auth.getUser();

    if (!auth.user) {
      setMessage("Please login again.");
      setLoading(false);
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("school_id")
      .eq("id", auth.user.id)
      .single();

    if (profileError || !profile?.school_id) {
      setMessage(
        profileError?.message || "School is not linked to this account.",
      );
      setLoading(false);
      return;
    }

    setSchoolId(profile.school_id);

    const [
      yearsRes,
      classesRes,
      sectionsRes,
      subjectsRes,
      streamsRes,
    ] = await Promise.all([
      supabase
        .from("academic_years")
        .select("id,name,start_date,end_date,is_current")
        .eq("school_id", profile.school_id)
        .order("start_date", { ascending: false }),

      supabase
        .from("classes")
        .select("id,name,sort_order,is_active")
        .eq("school_id", profile.school_id)
        .order("sort_order"),

      supabase
        .from("sections")
        .select("id,class_id,name")
        .eq("school_id", profile.school_id)
        .order("name"),

      supabase
        .from("subjects")
        .select(
          "id,code,name,description,is_practical,is_active",
        )
        .eq("school_id", profile.school_id)
        .order("name"),

      supabase
        .from("streams")
        .select("id,name")
        .eq("school_id", profile.school_id)
        .order("name"),
    ]);

    const firstError =
      yearsRes.error ||
      classesRes.error ||
      sectionsRes.error ||
      subjectsRes.error ||
      streamsRes.error;

    if (firstError) {
      setMessage(firstError.message);
    }

    setYears(yearsRes.data ?? []);
    setClasses(classesRes.data ?? []);
    setSections(sectionsRes.data ?? []);
    setSubjects(subjectsRes.data ?? []);
    setStreams(streamsRes.data ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const sectionCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const section of sections) {
      counts.set(
        section.class_id,
        (counts.get(section.class_id) ?? 0) + 1,
      );
    }

    return counts;
  }, [sections]);

  async function addSubject(event: FormEvent) {
    event.preventDefault();

    if (!schoolId || !subjectForm.name.trim()) {
      return;
    }

    setSavingSubject(true);
    setMessage("");

    const { error } = await supabase.from("subjects").insert({
      school_id: schoolId,
      code: subjectForm.code.trim() || null,
      name: subjectForm.name.trim(),
      is_practical: subjectForm.practical,
      is_active: true,
    });

    if (error) {
      setMessage(error.message);
    } else {
      setSubjectForm({
        code: "",
        name: "",
        practical: false,
      });

      setMessage("Subject added successfully.");
      await load();
    }

    setSavingSubject(false);
  }

  return (
    <main className="min-h-screen bg-[#080d1d] px-5 py-8 text-white md:px-10">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link
              href="/dashboard"
              className="text-sm text-slate-400 hover:text-white"
            >
              ← Back to dashboard
            </Link>

            <div className="mt-5 text-xs font-semibold uppercase tracking-[0.28em] text-blue-400">
              Academics · Configuration
            </div>

            <h1 className="mt-2 text-4xl font-black tracking-tight">
              Academic Setup
            </h1>

            <p className="mt-2 text-slate-400">
              Configure the academic master data used by Students,
              Teachers, Attendance and Learning.
            </p>
          </div>

          <button
            onClick={load}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-semibold hover:bg-slate-800"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>

        {message && (
          <div className="mb-6 rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-200">
            {message}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ["Academic Years", years.length, CalendarDays],
              ["Classes", classes.length, GraduationCap],
              ["Sections", sections.length, Layers3],
              ["Subjects", subjects.length, BookOpen],
            ] as const
          ).map(([label, value, Icon]) => (
            <div
              key={String(label)}
              className="rounded-2xl border border-slate-800 bg-[#111a31] p-5"
            >
              <Icon size={20} className="text-blue-400" />

              <div className="mt-5 text-3xl font-black">
                {String(value)}
              </div>

              <div className="mt-1 text-sm text-slate-400">
                {String(label)}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_.7fr]">
          <section className="rounded-2xl border border-slate-800 bg-[#111a31]">
            <div className="border-b border-slate-800 px-6 py-5">
              <h2 className="text-lg font-bold">
                Academic Structure
              </h2>

              <p className="mt-1 text-sm text-slate-400">
                Current year, Playway–12 structure and sections already
                available to the ERP.
              </p>
            </div>

            <div className="p-6">
              {loading ? (
                <div className="py-10 text-center text-slate-400">
                  Loading academic data…
                </div>
              ) : (
                <div className="space-y-3">
                  {classes.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-xl border border-slate-800 bg-[#0c1428] px-4 py-3"
                    >
                      <div>
                        <div className="font-semibold">
                          {item.name}
                        </div>

                        <div className="text-xs text-slate-500">
                          {sectionCounts.get(item.id) ?? 0} sections
                        </div>
                      </div>

                      <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
                        {item.is_active ? "Active" : "Inactive"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-[#111a31]">
            <div className="border-b border-slate-800 px-6 py-5">
              <h2 className="text-lg font-bold">
                Add Subject
              </h2>

              <p className="mt-1 text-sm text-slate-400">
                Subjects are school-level masters and can then be
                assigned to teachers/classes.
              </p>
            </div>

            <form onSubmit={addSubject} className="space-y-4 p-6">
              <div>
                <label className="mb-2 block text-sm text-slate-300">
                  Subject Code
                </label>

                <input
                  value={subjectForm.code}
                  onChange={(e) =>
                    setSubjectForm((v) => ({
                      ...v,
                      code: e.target.value,
                    }))
                  }
                  placeholder="e.g. BIO"
                  className="w-full rounded-xl border border-slate-700 bg-[#0c1428] px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm text-slate-300">
                  Subject Name *
                </label>

                <input
                  required
                  value={subjectForm.name}
                  onChange={(e) =>
                    setSubjectForm((v) => ({
                      ...v,
                      name: e.target.value,
                    }))
                  }
                  placeholder="e.g. Biology"
                  className="w-full rounded-xl border border-slate-700 bg-[#0c1428] px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <label className="flex items-center gap-3 rounded-xl border border-slate-700 bg-[#0c1428] px-4 py-3 text-sm">
                <input
                  type="checkbox"
                  checked={subjectForm.practical}
                  onChange={(e) =>
                    setSubjectForm((v) => ({
                      ...v,
                      practical: e.target.checked,
                    }))
                  }
                />

                Practical subject
              </label>

              <button
                type="submit"
                disabled={savingSubject}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 font-semibold hover:bg-blue-500 disabled:opacity-60"
              >
                <Plus size={17} />

                {savingSubject
                  ? "Saving…"
                  : "Add Subject"}
              </button>
            </form>
          </section>
        </div>

        <section className="mt-6 rounded-2xl border border-slate-800 bg-[#111a31]">
          <div className="border-b border-slate-800 px-6 py-5">
            <h2 className="text-lg font-bold">
              Subjects
            </h2>

            <p className="mt-1 text-sm text-slate-400">
              These subjects will appear in Teacher → Assignments.
            </p>
          </div>

          <div className="grid gap-3 p-6 sm:grid-cols-2 lg:grid-cols-4">
            {subjects.map((subject) => (
              <div
                key={subject.id}
                className="rounded-xl border border-slate-800 bg-[#0c1428] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">
                      {subject.name}
                    </div>

                    <div className="mt-1 text-xs text-slate-500">
                      {subject.code || "No code"}
                    </div>
                  </div>

                  {subject.is_practical && (
                    <span className="rounded-full bg-purple-500/10 px-2 py-1 text-[10px] text-purple-300">
                      Practical
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6 rounded-2xl border border-slate-800 bg-[#111a31] p-6">
          <h2 className="text-lg font-bold">
            Senior Secondary Streams
          </h2>

          <p className="mt-1 text-sm text-slate-400">
            Available for Class 11–12 configuration.
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            {streams.map((stream) => (
              <span
                key={stream.id}
                className="rounded-xl border border-slate-700 bg-[#0c1428] px-4 py-2 text-sm"
              >
                {stream.name}
              </span>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}