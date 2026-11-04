"use client";

import { useCallback, useEffect, useRef, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type PersonRecord = {
  id: string;
  name: string;
  code: string;
  detail: string;
  subdetail: string;
};

type Mode = "students" | "teachers" | "parents";

function logError(context: string, error: unknown) {
  if (error && typeof error === "object") {
    const item = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    console.error(context, {
      message: item.message,
      details: item.details,
      hint: item.hint,
      code: item.code,
    });
  } else {
    console.error(context, error);
  }
}

export function AdminPeopleWorkspace({ mode }: { mode: Mode }) {
  return <PeopleWorkspace key={mode} mode={mode} />;
}

function PeopleWorkspace({ mode }: { mode: Mode }) {
  const [supabase] = useState(createClient);
  const latestRequest = useRef(0);
  const mounted = useRef(true);
  const [records, setRecords] = useState<PersonRecord[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const request = ++latestRequest.current;
    const isCurrent = () => mounted.current && request === latestRequest.current;
    return supabase.auth.getUser().then(async ({ data: auth, error: authError }) => {
      try {
        if (!isCurrent()) return;
        setLoading(true);
        setError("");
        if (authError) throw authError;
        if (!auth.user) throw new Error("Please sign in again.");
        const { data: roles, error: rolesError } = await supabase
          .from("user_roles")
          .select("role,school_id")
          .eq("user_id", auth.user.id);
        if (rolesError) throw rolesError;

        let schoolId = (roles ?? []).find((row) =>
          row.role === "school_admin" && row.school_id,
        )?.school_id ?? "";
        if (!schoolId && (roles ?? []).some((row) => row.role === "super_admin")) {
          const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("school_id")
            .eq("id", auth.user.id)
            .maybeSingle();
          if (profileError) throw profileError;
          schoolId = profile?.school_id ?? "";
        }
        if (!schoolId) throw new Error("Choose a school-linked admin account to view school records.");

        if (mode === "students") {
          const { data: studentRows, error: studentError } = await supabase
            .from("students")
            .select("id,admission_no,first_name,middle_name,last_name,roll_no,status")
            .eq("school_id", schoolId)
            .order("first_name");
          if (studentError) throw studentError;
          if (!isCurrent()) return;
          setRecords((studentRows ?? []).map((student) => ({
            id: student.id,
            name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
            code: student.admission_no,
            detail: student.status,
            subdetail: student.roll_no ? `Roll no. ${student.roll_no}` : "",
          })));
          return;
        }

        if (mode === "teachers") {
          const [{ data: teacherRows, error: teacherError }, { data: year, error: yearError }] = await Promise.all([
            supabase.from("teachers").select("id,full_name,employee_id,designation,department,registered_mobile,qualification").eq("school_id", schoolId).order("full_name"),
            supabase.from("academic_years").select("id").eq("school_id", schoolId).eq("is_current", true).maybeSingle(),
          ]);
          if (teacherError) throw teacherError;
          if (yearError) throw yearError;
          const teacherIds = (teacherRows ?? []).map((teacher) => teacher.id);
          const { data: assignmentRows, error: assignmentError } = teacherIds.length && year?.id
            ? await supabase.from("teacher_subject_assignments").select("teacher_id,class_id,section_id,subject_id").eq("academic_year_id", year.id).in("teacher_id", teacherIds)
            : { data: [], error: null };
          if (assignmentError) throw assignmentError;
          const assignmentRecords = assignmentRows ?? [];
          const classIds = [...new Set(assignmentRecords.map((row) => row.class_id))];
          const sectionIds = [...new Set(assignmentRecords.map((row) => row.section_id).filter(Boolean))] as string[];
          const subjectIds = [...new Set(assignmentRecords.map((row) => row.subject_id))];
          const [classResult, sectionResult, subjectResult] = await Promise.all([
            classIds.length ? supabase.from("classes").select("id,name").eq("school_id", schoolId).in("id", classIds) : Promise.resolve({ data: [], error: null }),
            sectionIds.length ? supabase.from("sections").select("id,name").eq("school_id", schoolId).in("id", sectionIds) : Promise.resolve({ data: [], error: null }),
            subjectIds.length ? supabase.from("subjects").select("id,name").eq("school_id", schoolId).in("id", subjectIds) : Promise.resolve({ data: [], error: null }),
          ]);
          const nameError = classResult.error ?? sectionResult.error ?? subjectResult.error;
          if (nameError) throw nameError;
          const classNames = new Map((classResult.data ?? []).map((row) => [row.id, row.name]));
          const sectionNames = new Map((sectionResult.data ?? []).map((row) => [row.id, row.name]));
          const subjectNames = new Map((subjectResult.data ?? []).map((row) => [row.id, row.name]));
          const byTeacher = new Map<string, string[]>();
          for (const assignment of assignmentRecords) {
            const label = `${classNames.get(assignment.class_id) ?? "Class"} ${assignment.section_id ? sectionNames.get(assignment.section_id) ?? "" : ""} · ${subjectNames.get(assignment.subject_id) ?? "Subject"}`;
            byTeacher.set(assignment.teacher_id, [...(byTeacher.get(assignment.teacher_id) ?? []), label]);
          }
          if (!isCurrent()) return;
          setRecords((teacherRows ?? []).map((teacher) => ({
            id: teacher.id,
            name: teacher.full_name || "Teacher",
            code: teacher.employee_id || "",
            detail: [teacher.designation, teacher.department].filter(Boolean).join(" · ") || teacher.qualification || "Staff",
            subdetail: [...new Set(byTeacher.get(teacher.id) ?? [])].join(", ") || "No current-year assignments",
          })));
          return;
        }

        const [{ data: parentRows, error: parentError }, { data: studentRows, error: studentsError }] = await Promise.all([
          supabase.from("parents").select("id").eq("school_id", schoolId),
          supabase.from("students").select("id,first_name,middle_name,last_name").eq("school_id", schoolId),
        ]);
        if (parentError) throw parentError;
        if (studentsError) throw studentsError;
        const parentIds = (parentRows ?? []).map((parent) => parent.id);
        const { data: linkRows, error: linksError } = parentIds.length
          ? await supabase.from("student_parents").select("parent_id,student_id").in("parent_id", parentIds)
          : { data: [], error: null };
        if (linksError) throw linksError;
        const childNames = new Map((studentRows ?? []).map((student) => [
          student.id,
          [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
        ]));
        const linkedChildren = new Map<string, string[]>();
        for (const link of linkRows ?? []) {
          const childName = childNames.get(link.student_id);
          if (childName) linkedChildren.set(link.parent_id, [...(linkedChildren.get(link.parent_id) ?? []), childName]);
        }
        if (!isCurrent()) return;
        setRecords((parentRows ?? []).map((parent) => {
          const children = [...new Set(linkedChildren.get(parent.id) ?? [])];
          return {
            id: parent.id,
            name: "Parent account",
            code: "",
            detail: `${children.length} linked ${children.length === 1 ? "student" : "students"}`,
            subdetail: children.join(", "),
          };
        }));
      } catch (loadError) {
        if (!isCurrent()) return;
        logError(`Admin ${mode} data load failed`, loadError);
        setError("School records could not be loaded. Please refresh or contact your administrator.");
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }, (loadError: unknown) => {
      if (!isCurrent()) return;
      logError(`Admin ${mode} data load failed`, loadError);
      setError("School records could not be loaded. Please refresh or contact your administrator.");
      setLoading(false);
    });
  }, [supabase, mode]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; latestRequest.current += 1; };
  }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return records;
    return records.filter((record) =>
      `${record.name} ${record.code} ${record.detail} ${record.subdetail}`.toLocaleLowerCase().includes(term),
    );
  }, [records, search]);

  const labels: Record<Mode, { title: string; description: string }> = {
    students: { title: "Students", description: "School-scoped student directory and enrollment identifiers." },
    teachers: { title: "Teachers & Staff", description: "School staff directory with current-year teaching responsibilities." },
    parents: { title: "Parents", description: "Linked parent records and their associated students." },
  };
  const { title, description } = labels[mode];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-blue-600">School Administration</p>
          <h1 className="mt-1 text-3xl font-black">{title}</h1>
          <p className="mt-2 text-sm muted">{description}</p>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--surface-2)]">
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      <section className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--border)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold">{records.length} records</p>
          <label className="relative block w-full sm:max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 muted" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${title.toLowerCase()}`} className="field w-full pl-9" />
          </label>
        </div>
        {error && <div role="alert" className="m-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>}
        {loading ? <p className="p-5 text-sm muted">Loading {title.toLowerCase()}…</p> : filtered.length === 0 ? (
          <p className="p-5 text-sm muted">{records.length ? "No records match your search." : `No ${title.toLowerCase()} found for this school.`}</p>
        ) : <div className="divide-y divide-[var(--border)]">
          {filtered.map((record) => (
            <article key={record.id} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="font-semibold">{record.name}<span className="ml-2 text-xs font-normal muted">{record.code}</span></div>
              <div className="text-sm muted sm:text-right">{record.detail}{record.subdetail && <span className="block text-xs">{record.subdetail}</span>}</div>
            </article>
          ))}
        </div>}
      </section>
      <p className="text-xs muted">This directory is read-only. User provisioning and profile changes require an established secure Admin workflow, which is not present in the repository schema.</p>
    </div>
  );
}
