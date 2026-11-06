"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { downloadHomeworkFile } from "@/lib/homework/files";
import { gradeHomework, homeworkError, loadHomeworkRoster, type HomeworkRoster, type HomeworkSubmission } from "@/lib/homework/submissions";
import { LoadingState } from "@/components/ui/skeleton";

const action = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";

export function TeacherHomeworkGrading({ activityId, userId }: { activityId: string; userId: string }) {
  const [client] = useState(createClient);
  const [open, setOpen] = useState(false);
  const [roster, setRoster] = useState<HomeworkRoster>();
  const [target, setTarget] = useState<HomeworkSubmission>();
  const [marks, setMarks] = useState("");
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloadingId, setDownloadingId] = useState("");
  const [conflict, setConflict] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = useRef(false);
  const selected = useRef<HomeworkSubmission | undefined>(undefined);
  const inFlight = useRef(false);
  const loadVersion = useRef(0);
  const readController = useRef<AbortController | undefined>(undefined);
  const writeController = useRef<AbortController | undefined>(undefined);
  const downloadController = useRef<AbortController | undefined>(undefined);
  const request = useRef<{ payload: string; id: string; expectedRevision: number } | undefined>(undefined);
  const panelId = useId();
  const marksId = useId();
  const feedbackId = useId();
  const maxHintId = useId();

  const load = useCallback(async (mode: "manual" | "background" | "saved" = "manual") => {
    const version = ++loadVersion.current;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setLoading(true);
    try {
      const current = await loadHomeworkRoster(client, activityId, controller.signal);
      if (controller.signal.aborted || version !== loadVersion.current) return;
      const next = selected.current ? current.students.find((row) => row.submission?.id === selected.current?.id)?.submission : undefined;
      setRoster(current);
      if (selected.current && dirty.current && mode === "background" && next?.revision !== selected.current.revision) {
        setConflict(true); setError("This submission changed in another session. Your draft is kept; refresh its status before trying again.");
        return;
      }
      if (selected.current && !next) {
        selected.current = undefined; setTarget(undefined); setMarks(""); setFeedback(""); dirty.current = false; request.current = undefined;
      } else if (next) {
        selected.current = next; setTarget(next);
        if (!dirty.current || mode === "saved") { setMarks(next.marks === null ? "" : String(next.marks)); setFeedback(next.feedback ?? ""); dirty.current = false; request.current = undefined; }
      }
      setConflict(false); setError("");
    } catch (loadError) {
      if (controller.signal.aborted || version !== loadVersion.current) return;
      setRoster(undefined);
      if ((loadError as { code?: string })?.code === "42501") {
        selected.current = undefined; setTarget(undefined); setMarks(""); setFeedback(""); dirty.current = false; request.current = undefined;
      }
      setError(homeworkError(loadError, "Submissions could not be loaded. Refresh teaching access before grading."));
    } finally { if (version === loadVersion.current && !controller.signal.aborted) setLoading(false); }
  }, [client, activityId]);

  useEffect(() => {
    if (!open) return;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        readController.current?.abort(); writeController.current?.abort(); downloadController.current?.abort(); loadVersion.current += 1;
        setRoster(undefined); selected.current = undefined; setTarget(undefined); setMarks(""); setFeedback(""); setSessionChanged(true);
      }
    });
    return () => { subscription.unsubscribe(); readController.current?.abort(); writeController.current?.abort(); downloadController.current?.abort(); loadVersion.current += 1; };
  }, [client, userId, open]);

  useEffect(() => {
    if (!open || sessionChanged) return;
    const refresh = () => { if (!inFlight.current && !request.current && document.visibilityState !== "hidden") void load("background"); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => { readController.current?.abort(); window.clearInterval(interval); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load, open, sessionChanged]);

  function select(submission: HomeworkSubmission) {
    selected.current = submission; setTarget(submission); setMarks(submission.marks === null ? "" : String(submission.marks));
    setFeedback(submission.feedback ?? ""); dirty.current = false; request.current = undefined; setError(""); setMessage(""); setConflict(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || !roster || sessionChanged || inFlight.current || conflict || loading) return;
    const numeric = marks.trim() === "" ? null : Number(marks);
    if (numeric !== null && (!Number.isFinite(numeric) || numeric < 0 || roster.activity.max_marks === null || numeric > roster.activity.max_marks)) {
      setError("Enter marks between zero and the homework maximum, or leave marks blank and add feedback."); return;
    }
    if (numeric === null && !feedback.trim()) { setError("Add marks or written feedback before saving the grade."); return; }
    inFlight.current = true; setSaving(true); setError(""); setMessage("");
    const controller = new AbortController(); writeController.current = controller;
    const payload = { submissionId: target.id, marks: numeric, feedback };
    const encoded = JSON.stringify(payload);
    if (request.current?.payload !== encoded) request.current = { payload: encoded, id: crypto.randomUUID(), expectedRevision: target.revision };
    try {
      await gradeHomework(client, { ...payload, expectedRevision: request.current.expectedRevision, requestId: request.current.id }, controller.signal);
      if (controller.signal.aborted) return;
      dirty.current = false; request.current = undefined; setMessage("Grade saved. The latest saved result is shown below.");
      await load("saved");
    } catch (gradeError) {
      if (!controller.signal.aborted) {
        if (["PT409", "40001", "23505"].includes((gradeError as { code?: string })?.code ?? "")) { request.current = undefined; setConflict(true); }
        if ((gradeError as { code?: string })?.code === "42501") {
          setRoster(undefined); selected.current = undefined; setTarget(undefined); setMarks(""); setFeedback(""); request.current = undefined; dirty.current = false;
        }
        setError(homeworkError(gradeError, "The grade could not be saved. Your marks and feedback are kept for retry."));
      }
    }
    finally { inFlight.current = false; if (!controller.signal.aborted) setSaving(false); }
  }

  async function download(submission: HomeworkSubmission) {
    if (!submission.file_path || downloadingId || sessionChanged) return;
    const controller = new AbortController(); downloadController.current = controller;
    setDownloadingId(submission.id); setError("");
    try { await downloadHomeworkFile(client, submission.id, submission.file_name ?? undefined, controller.signal); }
    catch (downloadError) {
      if (!controller.signal.aborted && (downloadError as { name?: string })?.name !== "AbortError") setError(homeworkError(downloadError, "This attachment could not be downloaded. Refresh teaching access and try again."));
    } finally {
      if (downloadController.current === controller) downloadController.current = undefined;
      if (!controller.signal.aborted) setDownloadingId("");
    }
  }

  const submittedCount = roster?.students.filter((row) => row.submission?.status === "submitted").length ?? 0;
  const gradedCount = roster?.students.filter((row) => row.submission?.status === "graded").length ?? 0;
  return <section className="mt-4 min-w-0 space-y-3 border-t border-[var(--border)] pt-4" aria-label="Homework submissions and grading">
    <button type="button" className={action} aria-expanded={open} aria-controls={panelId} disabled={saving} onClick={() => { if (open) { downloadController.current?.abort(); setDownloadingId(""); } else if (!sessionChanged) void load(); setOpen((value) => !value); }}>{open ? "Hide submissions" : "View submissions"}</button>
    {open && <div id={panelId} className="min-w-0 space-y-3">
      {sessionChanged ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reopen Homework before grading.</p> : <>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-bold">Student submissions</h4><button type="button" className={action} disabled={loading || saving} onClick={() => { setMessage(""); void load(); }}>Refresh submissions</button></div>
        {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        {loading && <LoadingState variant="table" className="text-sm muted">Checking homework submissions…</LoadingState>}
        {roster && <>
          <p className="text-sm muted">{roster.students.length} students · {submittedCount} submitted · {gradedCount} graded · {roster.students.length - submittedCount - gradedCount} pending</p>
          {roster.students.length === 0 ? <p className="text-sm muted">No active pupils are enrolled in this homework section.</p> : <ul className="space-y-3">{roster.students.map((row) => {
            const name = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" ");
            const submission = row.submission;
            return <li key={row.student_id} className="min-w-0 space-y-3 rounded-xl border border-[var(--border)] p-3 sm:p-4">
              <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-semibold">{name || "Student"}</p><p className="text-xs muted">{row.admission_no ?? "Admission number unavailable"}</p></div><p className="text-sm font-semibold">{submission ? submission.status === "graded" ? "Graded" : "Submitted" : "Not submitted"}</p></div>
              {submission && <>
                <p className="whitespace-pre-wrap break-words text-sm">{submission.text_response || "Attachment submitted without a text response."}</p>
                {submission.file_path && <button type="button" className={`${action} max-w-full break-all text-left`} disabled={Boolean(downloadingId)} onClick={() => void download(submission)}>{downloadingId === submission.id ? "Downloading attachment…" : `Download attachment${submission.file_name ? ` · ${submission.file_name}` : ""}`}</button>}
                {submission.status === "graded" && <div className="space-y-1 text-sm"><p className="font-semibold">Marks: {submission.marks === null ? "Feedback only" : `${submission.marks}${roster.activity.max_marks === null ? "" : ` / ${roster.activity.max_marks}`}`}</p>{submission.feedback && <p className="whitespace-pre-wrap break-words">{submission.feedback}</p>}</div>}
                <button type="button" className={action} disabled={saving || loading} onClick={() => select(submission)}>{submission.status === "graded" ? "Edit grade" : "Grade submission"}</button>
                {target?.id === submission.id && <form aria-label={`Grade homework for ${name || row.student_id}`} onSubmit={save} className="space-y-3 rounded-xl bg-[var(--surface-2)] p-3">
                  <p id={maxHintId} className="text-sm muted">{roster.activity.max_marks === null ? "No maximum marks set. Add feedback now, or set maximum marks in the homework editor for a numeric grade." : `Maximum marks: ${roster.activity.max_marks}`}</p>
                  <div className="grid gap-3 sm:grid-cols-[minmax(120px,0.35fr)_1fr]">
                    <label htmlFor={marksId} className="block space-y-2 text-sm font-semibold">Marks<input id={marksId} type="number" min={0} max={roster.activity.max_marks ?? undefined} step="0.01" value={marks} disabled={saving || loading || roster.activity.max_marks === null} aria-describedby={maxHintId} className="field w-full" onChange={(event) => { setMarks(event.target.value); dirty.current = true; request.current = undefined; setMessage(""); }} /></label>
                    <label htmlFor={feedbackId} className="block space-y-2 text-sm font-semibold">Feedback<textarea id={feedbackId} maxLength={2000} rows={3} value={feedback} disabled={saving || loading} className="field w-full" onChange={(event) => { setFeedback(event.target.value); dirty.current = true; request.current = undefined; setMessage(""); }} /></label>
                  </div>
                  <div className="flex flex-wrap gap-2"><button type="submit" className={`${action} bg-blue-700 text-white`} disabled={saving || loading || conflict || (!marks.trim() && !feedback.trim())}>{saving ? "Saving grade…" : "Save grade"}</button><button type="button" className={action} disabled={saving} onClick={() => { selected.current = undefined; setTarget(undefined); setMarks(""); setFeedback(""); dirty.current = false; request.current = undefined; }}>Cancel grading</button></div>
                </form>}
              </>}
            </li>;
          })}</ul>}
        </>}
      </>}
    </div>}
  </section>;
}
