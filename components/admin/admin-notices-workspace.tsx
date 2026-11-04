"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Megaphone, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { schoolDate } from "@/lib/attendance/types";
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
const audienceChoices = ["Everyone", "Students", "Parents", "Teachers", "Staff", "Specific Class", "Specific Section"] as const;
type AudienceKind = (typeof audienceChoices)[number] | "Existing audience";
const audienceForRole = new Map<string, AudienceKind>([
  ["student", "Students"], ["parent", "Parents"], ["teacher", "Teachers"], ["staff", "Staff"],
]);
const schoolDateTime = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
});

function readAudience(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    roles: Array.isArray(record.roles) ? record.roles.filter((role): role is string => typeof role === "string") : [],
    teacherId: typeof record.teacher_id === "string" ? record.teacher_id : "",
    sectionId: typeof record.section_id === "string" ? record.section_id : "",
    classId: typeof record.class_id === "string" ? record.class_id : "",
  };
}

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
  const [loadedAt, setLoadedAt] = useState(0);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [audience, setAudience] = useState<AudienceKind>("Everyone");
  const [audienceChanged, setAudienceChanged] = useState(false);
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [publishDate, setPublishDate] = useState(schoolDate);
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

        let resolvedSchoolId = (roles ?? []).find((row) => row.role === "school_admin" && row.school_id)?.school_id
          ?? (roles ?? []).find((row) => row.role === "principal" && row.school_id)?.school_id ?? "";
        if (!resolvedSchoolId && (roles ?? []).some((row) => row.role === "super_admin")) {
          const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("school_id")
            .eq("id", auth.user.id)
            .maybeSingle();
          if (profileError) throw profileError;
          resolvedSchoolId = profile?.school_id ?? "";
        }
        if (!resolvedSchoolId) throw new Error("Choose a school-linked administrator or principal to manage notices.");

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
        setLoadedAt(Date.now());
        setClasses(classResult.data ?? []);
        setSections(sectionResult.data ?? []);
      } catch (loadError) {
        if (!isCurrent()) return;
        logError("Admin notices load failed", loadError);
        setSchoolId("");
        setNotices([]);
        setError("Notices could not be loaded. Please refresh or contact your administrator.");
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }, (loadError: unknown) => {
      if (!isCurrent()) return;
      logError("Admin notices load failed", loadError);
      setSchoolId("");
      setNotices([]);
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
    setAudienceChanged(false);
    setTitle(notice.title);
    setContent(notice.content);
    const data = readAudience(notice.audience);
    if (data.teacherId) {
      setAudience("Existing audience");
      setClassId("");
      setSectionId("");
    } else if (data.sectionId) {
      setAudience("Specific Section");
      setSectionId(data.sectionId);
      setClassId(sections.find((section) => section.id === data.sectionId)?.class_id ?? "");
    } else if (data.classId) {
      setAudience("Specific Class");
      setClassId(data.classId);
      setSectionId("");
    } else {
      const schoolWide = (Array.isArray(notice.audience) && notice.audience.length === 0)
        || [...audienceForRole.keys()].every((role) => data.roles.includes(role));
      setAudience(schoolWide ? "Everyone"
        : data.roles.length === 1 ? audienceForRole.get(data.roles[0]) ?? "Existing audience"
        : "Existing audience");
      setClassId("");
      setSectionId("");
    }
    setPublishDate(notice.published_at ? schoolDate(new Date(notice.published_at)) : schoolDate());
    setPublishStatus(notice.published_at ? "Published" : "Draft");
    setMessage("");
    setError("");
  }

  function reset() {
    setEditingId("");
    setTitle("");
    setContent("");
    setAudience("Everyone");
    setAudienceChanged(false);
    setClassId("");
    setSectionId("");
    setPublishDate(schoolDate());
    setPublishStatus("Published");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !userId || !title.trim() || !content.trim() || saving || loading) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const selectedRole = [...audienceForRole].find(([, label]) => label === audience)?.[0];
      const roles = audience === "Everyone"
        ? [...audienceForRole.keys()]
        : audience === "Specific Class" || audience === "Specific Section"
          ? ["student", "parent"]
          : selectedRole ? [selectedRole] : [];
      const audienceData: Record<string, string | string[]> = { roles };
      if (audience === "Specific Class" || audience === "Specific Section") audienceData.class_id = classId;
      if (audience === "Specific Section") audienceData.section_id = sectionId;
      const original = notices.find((notice) => notice.id === editingId);
      const originalPublishTime = original?.published_at;
      const publishedAt = publishStatus === "Draft" ? null
        : originalPublishTime && schoolDate(new Date(originalPublishTime)) === publishDate
          ? originalPublishTime
          : publishDate === schoolDate() ? new Date().toISOString() : `${publishDate}T09:00:00+05:30`;
      const payload = {
        title: title.trim(),
        content: content.trim(),
        published_at: publishedAt,
        audience: original && !audienceChanged ? original.audience : audienceData,
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
      setMessage(editingId ? "Notice updated." : !publishedAt ? "Draft saved."
        : Date.parse(publishedAt) > Date.now() ? "Notice scheduled." : "Notice published.");
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
    if (!schoolId || saving || loading) return;
    if (!window.confirm(`Delete the notice “${notice.title}”? This cannot be undone.`)) return;
    setSaving(true);
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
    } finally {
      setSaving(false);
    }
  }

  async function togglePublished(notice: Notice) {
    if (!schoolId || saving || loading) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const query = supabase
        .from("notices")
        .update({ published_at: notice.published_at ? null : new Date().toISOString() })
        .eq("id", notice.id)
        .eq("school_id", schoolId);
      const { data, error: updateError } = await (notice.published_at
        ? query.eq("published_at", notice.published_at)
        : query.is("published_at", null)).select("id").maybeSingle();
      if (updateError) throw updateError;
      if (!data) throw new Error("The notice status could not be updated.");
      setMessage(notice.published_at ? "Notice moved to drafts." : "Notice published.");
      await load();
    } catch (updateError) {
      logError("Admin notice status update failed", updateError);
      setError("Notice status could not be updated. Refresh and check the current status before retrying.");
    } finally {
      setSaving(false);
    }
  }

  const sectionsForClass = sections.filter((section) => section.class_id === classId);
  const audienceLabel = (value: unknown) => {
    if (Array.isArray(value) && value.length === 0) return "Everyone";
    const item = readAudience(value);
    if (item.teacherId) return "Teacher's assigned classes";
    if (item.sectionId) return `Section ${sections.find((section) => section.id === item.sectionId)?.name ?? "Selected"}`;
    if (item.classId) return classes.find((schoolClass) => schoolClass.id === item.classId)?.name ?? "Selected class";
    return item.roles.map((role) => audienceForRole.get(role) ?? role).join(", ") || "Unrecognized audience";
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-600">School Administration</p>
        <h1 className="mt-1 text-3xl font-black">Notices &amp; Circulars</h1>
        <p className="mt-2 text-sm muted">Publish announcements for a school audience, class, or section.</p>
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
            <select value={audience} onChange={(event) => { setAudience(event.target.value as AudienceKind); setAudienceChanged(true); setClassId(""); setSectionId(""); }} className="field w-full">
              {audience === "Existing audience" && <option value="Existing audience">Keep existing audience</option>}
              {audienceChoices.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          {(audience === "Specific Class" || audience === "Specific Section") && <label className="space-y-1.5 text-sm font-medium">Class
            <select required value={classId} onChange={(event) => { setClassId(event.target.value); setAudienceChanged(true); setSectionId(""); }} className="field w-full"><option value="">Select class</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>}
          {audience === "Specific Section" && <label className="space-y-1.5 text-sm font-medium">Section
            <select required value={sectionId} onChange={(event) => { setSectionId(event.target.value); setAudienceChanged(true); }} className="field w-full"><option value="">Select section</option>{sectionsForClass.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>}
          <label className="space-y-1.5 text-sm font-medium">Publish date (IST)
            <input type="date" required={publishStatus === "Published"} disabled={publishStatus === "Draft"} value={publishDate} onChange={(event) => setPublishDate(event.target.value)} className="field w-full" />
          </label>
          <label className="space-y-1.5 text-sm font-medium">Status
            <select value={publishStatus} onChange={(event) => setPublishStatus(event.target.value as "Published" | "Draft")} className="field w-full"><option>Published</option><option>Draft</option></select>
          </label>
          <label className="space-y-1.5 text-sm font-medium sm:col-span-2">Description
            <textarea required rows={5} value={content} onChange={(event) => setContent(event.target.value)} className="field w-full resize-y" />
          </label>
          <div className="flex flex-wrap gap-3 sm:col-span-2">
            <button disabled={loading || saving || !schoolId} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60">
              {editingId ? <Pencil size={16} /> : <Plus size={16} />}{saving ? "Saving…" : editingId ? "Save changes" : publishStatus === "Draft" ? "Save draft" : "Publish notice"}
            </button>
            {editingId && <button type="button" onClick={reset} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button>}
          </div>
        </form>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="text-lg font-bold">School notices</h2></div>
        {loading ? <p className="p-5 text-sm muted">Loading notices…</p> : notices.length === 0 ? (
          <p className="p-5 text-sm muted">No notices have been created for this school.</p>
        ) : <div className="divide-y divide-[var(--border)]">
          {notices.map((notice) => (
            <article key={notice.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3 className="font-bold">{notice.title}</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm muted">{notice.content}</p>
                <p className="mt-2 text-xs muted">{audienceLabel(notice.audience)} · {notice.published_at
                  ? `${Date.parse(notice.published_at) > loadedAt ? "Scheduled" : "Published"} ${schoolDateTime.format(new Date(notice.published_at))} IST`
                  : "Draft"}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" disabled={saving} onClick={() => beginEdit(notice)} aria-label={`Edit ${notice.title}`} className="rounded-lg border border-[var(--border)] p-2 hover:bg-[var(--surface-2)]"><Pencil size={16} /></button>
                <button type="button" disabled={saving} onClick={() => void togglePublished(notice)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold">{notice.published_at ? "Unpublish" : "Publish"}</button>
                <button type="button" disabled={saving} onClick={() => void remove(notice)} aria-label={`Delete ${notice.title}`} className="rounded-lg border border-red-300/50 p-2 text-red-600 hover:bg-red-500/10"><Trash2 size={16} /></button>
              </div>
            </article>
          ))}
        </div>}
      </section>
    </div>
  );
}
