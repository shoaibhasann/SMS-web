"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Megaphone, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { schoolDate } from "@/lib/attendance/types";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";

type Notice = {
  id: string;
  title: string;
  content: string;
  published_at: string | null;
  created_at: string | null;
  audience: unknown;
  version: string;
};
type Choice = { id: string; name: string };
type SectionChoice = Choice & { class_id: string };
const audienceChoices = ["Everyone", "Students", "Parents", "Teachers", "Staff", "Specific Class", "Specific Section"] as const;
type AudienceKind = (typeof audienceChoices)[number] | "Existing audience";
class NoticeVersionUnavailable extends Error {}
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
  const mutationPending = useRef(false);
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
  const [editingNotice, setEditingNotice] = useState<Notice | null>(null);
  const [conflictedId, setConflictedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const editingId = editingNotice?.id ?? "";

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
          supabase.from("notices").select("id,title,content,published_at,created_at,audience,version").eq("school_id", resolvedSchoolId).order("created_at", { ascending: false }),
          supabase.from("classes").select("id,name").eq("school_id", resolvedSchoolId).order("sort_order"),
          supabase.from("sections").select("id,name,class_id").eq("school_id", resolvedSchoolId).order("name"),
        ]);
        const failed = noticeResult.error ?? classResult.error ?? sectionResult.error;
        if (failed) {
          if ((noticeResult.error?.code === "42703" || noticeResult.error?.code === "PGRST204")
            && noticeResult.error.message.includes("version")) throw new NoticeVersionUnavailable();
          throw failed;
        }
        if ((noticeResult.data ?? []).some((notice) => typeof notice.version !== "string" || !notice.version)) {
          throw new NoticeVersionUnavailable();
        }
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
        setError(loadError instanceof NoticeVersionUnavailable
          ? "Notices need the latest database update before editing is available. Contact your administrator."
          : "Notices could not be loaded. Please refresh or contact your administrator.");
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
    // A list refresh must not silently rebase an existing editor's snapshot.
    setEditingNotice(structuredClone(notice));
    setConflictedId("");
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
    setError("");
    setEditingNotice(null);
    setConflictedId("");
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
    if (!schoolId || !userId || !title.trim() || !content.trim() || saving || loading || mutationPending.current
      || (editingId && conflictedId === editingId)) return;
    mutationPending.current = true;
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
      const original = editingNotice;
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
      const result = original
        ? await supabase.from("notices").update(payload).eq("id", original.id).eq("school_id", schoolId).eq("version", original.version).select("id").maybeSingle()
        : await supabase.from("notices").insert({
            ...payload,
            school_id: schoolId,
            created_by: userId,
          }).select("id").maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) {
        if (editingId) {
          setConflictedId(editingId);
          setError("This notice changed or is no longer available. Your draft is kept. Discard it and reload the current notice before retrying.");
          return;
        }
        throw new Error("The notice was not saved.");
      }
      setMessage(editingId ? "Notice updated." : !publishedAt ? "Draft saved."
        : Date.parse(publishedAt) > Date.now() ? "Notice scheduled." : "Notice published.");
      reset();
      await load();
    } catch (saveError) {
      logError("Admin notice save failed", saveError);
      if (editingId) setConflictedId(editingId);
      setError("Save could not be confirmed. Your draft is kept. Reload the current notice or refresh the list before retrying.");
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  }

  async function remove(notice: Notice) {
    if (!schoolId || saving || loading || mutationPending.current) return;
    if (!window.confirm(`Delete the notice “${notice.title}”? This cannot be undone.`)) return;
    mutationPending.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const { data, error: deleteError } = await supabase
        .from("notices")
        .delete()
        .eq("id", notice.id)
        .eq("school_id", schoolId)
        .eq("version", notice.version)
        .select("id")
        .maybeSingle();
      if (deleteError) throw deleteError;
      if (!data) {
        setConflictedId(notice.id);
        setError("This notice changed or is no longer available. Nothing was deleted. Refresh and review the current notice before retrying.");
        return;
      }
      if (editingId === notice.id) reset();
      setMessage("Notice deleted.");
      await load();
    } catch (deleteError) {
      logError("Admin notice delete failed", deleteError);
      setError("Deletion could not be confirmed. Refresh and check the current notice before retrying.");
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  }

  async function togglePublished(notice: Notice) {
    if (!schoolId || saving || loading || mutationPending.current) return;
    mutationPending.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const query = supabase
        .from("notices")
        .update({ published_at: notice.published_at ? null : new Date().toISOString() })
        .eq("id", notice.id)
        .eq("school_id", schoolId)
        .eq("version", notice.version);
      const { data, error: updateError } = await query.select("id").maybeSingle();
      if (updateError) throw updateError;
      if (!data) {
        setConflictedId(notice.id);
        setError("This notice changed or is no longer available. Its status was not changed. Refresh and review it before retrying.");
        return;
      }
      setMessage(notice.published_at ? "Notice moved to drafts." : "Notice published.");
      await load();
    } catch (updateError) {
      logError("Admin notice status update failed", updateError);
      setError("The status change could not be confirmed. Refresh and check the current notice before retrying.");
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  }

  async function reloadEditingNotice() {
    if (!schoolId || !editingNotice || saving || loading || mutationPending.current) return;
    mutationPending.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const { data, error: reloadError } = await supabase.from("notices")
        .select("id,title,content,published_at,created_at,audience,version")
        .eq("id", editingNotice.id).eq("school_id", schoolId).maybeSingle();
      if (reloadError) throw reloadError;
      if (!data) {
        setConflictedId(editingNotice.id);
        setError("This notice is no longer available. Your draft is kept; cancel it to start another notice.");
        return;
      }
      if (typeof data.version !== "string" || !data.version) throw new NoticeVersionUnavailable();
      beginEdit(data as Notice);
      setNotices((current) => current.map((notice) => notice.id === data.id ? data as Notice : notice));
      setMessage("Current notice loaded. The previous draft was discarded.");
    } catch (reloadError) {
      logError("Admin notice reload failed", reloadError);
      setError("The current notice could not be loaded. Your draft is kept. Try reloading again.");
    } finally {
      mutationPending.current = false;
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
          <button type="button" disabled={saving} onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-2)] disabled:opacity-60">
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
        <form onSubmit={save}>
          <fieldset disabled={loading || saving} className="grid min-w-0 gap-4 sm:grid-cols-2">
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
            <button disabled={loading || saving || !schoolId || (!!editingId && conflictedId === editingId)} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60">
              {editingId ? <Pencil size={16} /> : <Plus size={16} />}{saving ? "Saving…" : editingId ? "Save changes" : publishStatus === "Draft" ? "Save draft" : "Publish notice"}
            </button>
            {editingId && <button type="button" onClick={reset} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button>}
            {editingId && conflictedId === editingId && <button type="button" onClick={() => void reloadEditingNotice()} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Discard draft and reload</button>}
          </div>
          {editingId && conflictedId === editingId && <p className="text-sm text-amber-700 dark:text-amber-300 sm:col-span-2">Your draft is kept. Reload the current notice before saving again.</p>}
          </fieldset>
        </form>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="text-lg font-bold">School notices</h2></div>
        {loading ? <LoadingState variant="table" className="p-5 text-sm muted">Loading notices…</LoadingState> : notices.length === 0 ? (
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
