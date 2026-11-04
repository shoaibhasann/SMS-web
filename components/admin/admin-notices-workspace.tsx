"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Megaphone, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Notice = {
  id: string;
  title: string;
  content: string;
  published_at: string | null;
  created_at: string | null;
  audience: unknown;
};
type Choice = { id: string; name: string };
type SectionChoice = Choice & { class_id: string };
type AudienceKind = "Everyone" | "Students" | "Parents" | "Teachers" | "Staff" | "Specific Class" | "Specific Section";

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

export function AdminNoticesWorkspace() {
  const [supabase] = useState(createClient);
  const latestRequest = useRef(0);
  const mounted = useRef(true);
  const [schoolId, setSchoolId] = useState("");
  const [userId, setUserId] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [audience, setAudience] = useState<AudienceKind>("Everyone");
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [publishDate, setPublishDate] = useState(new Date().toISOString().slice(0, 10));
  const [publishStatus, setPublishStatus] = useState<"Published" | "Draft">("Published");
  const [classes, setClasses] = useState<Choice[]>([]);
  const [sections, setSections] = useState<SectionChoice[]>([]);
  const [editingId, setEditingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

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

        let resolvedSchoolId = (roles ?? []).find((row) =>
          row.role === "school_admin" && row.school_id,
        )?.school_id ?? "";
        if (!resolvedSchoolId && (roles ?? []).some((row) => row.role === "super_admin")) {
          const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("school_id")
            .eq("id", auth.user.id)
            .maybeSingle();
          if (profileError) throw profileError;
          resolvedSchoolId = profile?.school_id ?? "";
        }
        if (!resolvedSchoolId) throw new Error("Choose a school-linked admin account to manage notices.");

        const [noticeResult, classResult, sectionResult] = await Promise.all([
          supabase.from("notices").select("id,title,content,published_at,created_at,audience").eq("school_id", resolvedSchoolId).order("created_at", { ascending: false }),
          supabase.from("classes").select("id,name").eq("school_id", resolvedSchoolId).order("sort_order"),
          supabase.from("sections").select("id,name,class_id").eq("school_id", resolvedSchoolId).order("name"),
        ]);
        const failed = noticeResult.error ?? classResult.error ?? sectionResult.error;
        if (failed) throw failed;
        if (!isCurrent()) return;
        setUserId(auth.user.id);
        setSchoolId(resolvedSchoolId);
        setNotices((noticeResult.data ?? []) as Notice[]);
        setClasses(classResult.data ?? []);
        setSections(sectionResult.data ?? []);
      } catch (loadError) {
        if (!isCurrent()) return;
        logError("Admin notices load failed", loadError);
        setError("Notices could not be loaded. Please refresh or contact your administrator.");
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }, (loadError: unknown) => {
      if (!isCurrent()) return;
      logError("Admin notices load failed", loadError);
      setError("Notices could not be loaded. Please refresh or contact your administrator.");
      setLoading(false);
    });
  }, [supabase]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; latestRequest.current += 1; };
  }, [load]);

  function beginEdit(notice: Notice) {
    setEditingId(notice.id);
    setTitle(notice.title);
    setContent(notice.content);
    const data = notice.audience && typeof notice.audience === "object"
      ? notice.audience as { roles?: string[]; class_id?: string; section_id?: string }
      : {};
    if (data.section_id) {
      setAudience("Specific Section");
      setSectionId(data.section_id);
      setClassId(sections.find((section) => section.id === data.section_id)?.class_id ?? "");
    } else if (data.class_id) {
      setAudience("Specific Class");
      setClassId(data.class_id);
    } else {
      const role = data.roles?.[0];
      setAudience(role === "student" ? "Students" : role === "parent" ? "Parents" : role === "teacher" ? "Teachers" : role === "staff" ? "Staff" : "Everyone");
      setClassId("");
      setSectionId("");
    }
    setPublishDate(notice.published_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
    setPublishStatus(notice.published_at ? "Published" : "Draft");
    setMessage("");
    setError("");
  }

  function reset() {
    setEditingId("");
    setTitle("");
    setContent("");
    setAudience("Everyone");
    setClassId("");
    setSectionId("");
    setPublishDate(new Date().toISOString().slice(0, 10));
    setPublishStatus("Published");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !userId || !title.trim() || !content.trim()) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const roles = audience === "Everyone"
        ? ["student", "parent", "teacher", "staff"]
        : audience === "Specific Class" || audience === "Specific Section"
          ? ["student", "parent"]
          : [audience.toLocaleLowerCase()];
      const audienceData: Record<string, string | string[]> = { roles };
      if (audience === "Specific Class" && classId) audienceData.class_id = classId;
      if (audience === "Specific Section" && sectionId) audienceData.section_id = sectionId;
      const payload = {
        title: title.trim(),
        content: content.trim(),
        published_at: publishStatus === "Published" ? new Date(`${publishDate}T09:00:00`).toISOString() : null,
        audience: audienceData,
      };
      const result = editingId
        ? await supabase.from("notices").update(payload).eq("id", editingId).eq("school_id", schoolId).select("id").maybeSingle()
        : await supabase.from("notices").insert({
            ...payload,
            school_id: schoolId,
            created_by: userId,
          }).select("id").maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) throw new Error("The notice was not saved.");
      setMessage(editingId ? "Notice updated." : "Notice published.");
      reset();
      await load();
    } catch (saveError) {
      logError("Admin notice save failed", saveError);
      setError("Notice could not be saved. Check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(notice: Notice) {
    if (!window.confirm(`Delete the notice “${notice.title}”? This cannot be undone.`)) return;
    setError("");
    setMessage("");
    try {
      const { data, error: deleteError } = await supabase
        .from("notices")
        .delete()
        .eq("id", notice.id)
        .eq("school_id", schoolId)
        .select("id")
        .maybeSingle();
      if (deleteError) throw deleteError;
      if (!data) throw new Error("The notice was not deleted.");
      if (editingId === notice.id) reset();
      setMessage("Notice deleted.");
      await load();
    } catch (deleteError) {
      logError("Admin notice delete failed", deleteError);
      setError("Notice could not be deleted. It may be protected by school access policies.");
    }
  }

  async function togglePublished(notice: Notice) {
    setError("");
    setMessage("");
    try {
      const { data, error: updateError } = await supabase
        .from("notices")
        .update({ published_at: notice.published_at ? null : new Date().toISOString() })
        .eq("id", notice.id)
        .eq("school_id", schoolId)
        .select("id")
        .maybeSingle();
      if (updateError) throw updateError;
      if (!data) throw new Error("The notice status could not be updated.");
      setMessage(notice.published_at ? "Notice moved to drafts." : "Notice published.");
      await load();
    } catch (updateError) {
      logError("Admin notice status update failed", updateError);
      setError("Notice status could not be updated. Check your school access and try again.");
    }
  }

  const sectionsForClass = sections.filter((section) => section.class_id === classId);
  const audienceLabel = (value: unknown) => {
    if (!value || typeof value !== "object") return "Everyone";
    const item = value as { roles?: string[]; class_id?: string; section_id?: string };
    if (item.section_id) return `Section ${sections.find((section) => section.id === item.section_id)?.name ?? "Selected"}`;
    if (item.class_id) return classes.find((schoolClass) => schoolClass.id === item.class_id)?.name ?? "Selected class";
    return item.roles?.map((role) => role.charAt(0).toUpperCase() + role.slice(1)).join(", ") || "Everyone";
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-600">School Administration</p>
        <h1 className="mt-1 text-3xl font-black">Notices &amp; Circulars</h1>
        <p className="mt-2 text-sm muted">Publish school-wide announcements to students, parents, and teachers.</p>
      </header>

      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {message && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">{message}</div>}

      <section className="card p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Megaphone size={19} />{editingId ? "Edit notice" : "Publish a notice"}</h2>
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-2)]">
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5 text-sm font-medium">Title
            <input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} className="field w-full" />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">Audience
            <select value={audience} onChange={(event) => { setAudience(event.target.value as AudienceKind); setClassId(""); setSectionId(""); }} className="field w-full">
              {["Everyone", "Students", "Parents", "Teachers", "Staff", "Specific Class", "Specific Section"].map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          {(audience === "Specific Class" || audience === "Specific Section") && <label className="space-y-1.5 text-sm font-medium">Class
            <select required value={classId} onChange={(event) => { setClassId(event.target.value); setSectionId(""); }} className="field w-full"><option value="">Select class</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>}
          {audience === "Specific Section" && <label className="space-y-1.5 text-sm font-medium">Section
            <select required value={sectionId} onChange={(event) => setSectionId(event.target.value)} className="field w-full"><option value="">Select section</option>{sectionsForClass.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>}
          <label className="space-y-1.5 text-sm font-medium">Publish Date
            <input type="date" value={publishDate} onChange={(event) => setPublishDate(event.target.value)} className="field w-full" />
          </label>
          <label className="space-y-1.5 text-sm font-medium">Status
            <select value={publishStatus} onChange={(event) => setPublishStatus(event.target.value as "Published" | "Draft")} className="field w-full"><option>Published</option><option>Draft</option></select>
          </label>
          <label className="space-y-1.5 text-sm font-medium sm:col-span-2">Description
            <textarea required rows={5} value={content} onChange={(event) => setContent(event.target.value)} className="field w-full resize-y" />
          </label>
          <div className="flex flex-wrap gap-3 sm:col-span-2">
            <button disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60">
              {editingId ? <Pencil size={16} /> : <Plus size={16} />}{saving ? "Saving…" : editingId ? "Save changes" : "Publish notice"}
            </button>
            {editingId && <button type="button" onClick={reset} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button>}
          </div>
        </form>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="text-lg font-bold">Published notices</h2></div>
        {loading ? <p className="p-5 text-sm muted">Loading notices…</p> : notices.length === 0 ? (
          <p className="p-5 text-sm muted">No notices have been published for this school.</p>
        ) : <div className="divide-y divide-[var(--border)]">
          {notices.map((notice) => (
            <article key={notice.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3 className="font-bold">{notice.title}</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm muted">{notice.content}</p>
                <p className="mt-2 text-xs muted">{audienceLabel(notice.audience)} · {notice.published_at ? new Date(notice.published_at).toLocaleString() : "Draft"}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => beginEdit(notice)} aria-label={`Edit ${notice.title}`} className="rounded-lg border border-[var(--border)] p-2 hover:bg-[var(--surface-2)]"><Pencil size={16} /></button>
                <button type="button" onClick={() => void togglePublished(notice)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold">{notice.published_at ? "Unpublish" : "Publish"}</button>
                <button type="button" onClick={() => void remove(notice)} aria-label={`Delete ${notice.title}`} className="rounded-lg border border-red-300/50 p-2 text-red-600 hover:bg-red-500/10"><Trash2 size={16} /></button>
              </div>
            </article>
          ))}
        </div>}
      </section>
    </div>
  );
}
