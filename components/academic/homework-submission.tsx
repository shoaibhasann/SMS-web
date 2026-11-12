"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { HOMEWORK_FILE_ACCEPT, discardPendingHomeworkFile, downloadHomeworkFile, uploadHomeworkFile, validateHomeworkFile } from "@/lib/homework/files";
import { homeworkError, loadMyHomeworkSubmission, submitHomework, type HomeworkSubmission } from "@/lib/homework/submissions";
import { LoadingState } from "@/components/ui/skeleton";

type Scope = Parameters<typeof uploadHomeworkFile>[1];
type Uploaded = Awaited<ReturnType<typeof uploadHomeworkFile>>;
const action = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";

export function StudentHomeworkSubmission({ scope, userId, maxMarks }: { scope: Scope; userId: string; maxMarks?: number | null }) {
  const [client] = useState(createClient);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<HomeworkSubmission | null>();
  const [response, setResponse] = useState("");
  const [file, setFile] = useState<File>();
  const [uploaded, setUploaded] = useState<Uploaded>();
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<"uploading" | "submitting" | "removing">();
  const [downloading, setDownloading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const saved = useRef<HomeworkSubmission | null | undefined>(undefined);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const loadVersion = useRef(0);
  const readController = useRef<AbortController | undefined>(undefined);
  const writeController = useRef<AbortController | undefined>(undefined);
  const downloadController = useRef<AbortController | undefined>(undefined);
  const request = useRef<{ payload: string; id: string; expectedRevision: number | null } | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const responseId = useId();
  const fileId = useId();
  const graded = snapshot?.status === "graded";

  const load = useCallback(async (mode: "manual" | "background" | "saved" = "manual") => {
    const version = ++loadVersion.current;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setLoading(true);
    try {
      const current = await loadMyHomeworkSubmission(client, scope.activityId, scope.studentId, controller.signal);
      if (controller.signal.aborted || version !== loadVersion.current) return;
      if (mode === "background" && dirty.current && current?.status !== "graded"
        && (current?.revision ?? null) !== (saved.current?.revision ?? null)) {
        setConflict(true);
        setError("This submission changed in another session. Your draft is kept; refresh its status before trying again.");
        return;
      }
      saved.current = current; setSnapshot(current); setConflict(false);
      if (!dirty.current || mode === "saved" || current?.status === "graded") {
        setResponse(current?.text_response ?? ""); dirty.current = false;
        setFile(undefined); setUploaded(undefined); request.current = undefined;
        if (input.current) input.current.value = "";
      } else if (current?.file_path) {
        setFile(undefined); setUploaded(undefined);
        if (input.current) input.current.value = "";
      }
      setError("");
    } catch (loadError) {
      if (controller.signal.aborted || version !== loadVersion.current) return;
      saved.current = undefined; setSnapshot(undefined);
      if ((loadError as { code?: string })?.code === "42501") {
        setResponse(""); setFile(undefined); setUploaded(undefined); dirty.current = false; request.current = undefined;
      }
      setError(homeworkError(loadError, "Your homework status could not be loaded. Refresh before submitting."));
    } finally { if (version === loadVersion.current && !controller.signal.aborted) setLoading(false); }
  }, [client, scope.activityId, scope.studentId]);

  useEffect(() => {
    if (!open) return;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        readController.current?.abort(); writeController.current?.abort(); downloadController.current?.abort(); loadVersion.current += 1;
        saved.current = undefined; setSnapshot(undefined); setResponse(""); setFile(undefined); setUploaded(undefined);
        dirty.current = false; request.current = undefined; setSessionChanged(true);
      }
    });
    return () => { subscription.unsubscribe(); readController.current?.abort(); writeController.current?.abort(); downloadController.current?.abort(); loadVersion.current += 1; };
  }, [client, userId, open]);

  useEffect(() => {
    if (!open || sessionChanged) return;
    const refresh = () => { if (!inFlight.current && !request.current && document.visibilityState !== "hidden") void load("background"); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => { readController.current?.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load, open, sessionChanged]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || snapshot === undefined || graded || sessionChanged || conflict || loading) return;
    if (!response.trim() && !file && !uploaded && !snapshot?.file_path) { setError("Add a response or a PDF, JPG or PNG attachment."); return; }
    inFlight.current = true; setError(""); setMessage("");
    const controller = new AbortController(); writeController.current = controller;
    try {
      let attachment = uploaded;
      if (file && !attachment && !snapshot?.file_path) {
        setPhase("uploading");
        attachment = await uploadHomeworkFile(client, scope, file, controller.signal);
        if (controller.signal.aborted) return;
        setUploaded(attachment);
      }
      setPhase("submitting");
      const payload = { activityId: scope.activityId, text: response, filePath: snapshot?.file_path ?? attachment?.path ?? null,
        fileName: snapshot?.file_name ?? attachment?.name ?? null };
      const encoded = JSON.stringify(payload);
      if (request.current?.payload !== encoded) request.current = { payload: encoded, id: crypto.randomUUID(), expectedRevision: snapshot?.revision ?? null };
      await submitHomework(client, { ...payload, expectedRevision: request.current.expectedRevision, requestId: request.current.id }, controller.signal);
      if (controller.signal.aborted) return;
      dirty.current = false; request.current = undefined; setMessage("Homework submitted. Your saved status is shown below.");
      await load("saved");
    } catch (submitError) {
      if (!controller.signal.aborted) {
        if (["PT409", "40001", "23505"].includes((submitError as { code?: string })?.code ?? "")) { request.current = undefined; setConflict(true); }
        if ((submitError as { code?: string })?.code === "42501") {
          saved.current = undefined; setSnapshot(undefined); setResponse(""); setFile(undefined); setUploaded(undefined); dirty.current = false; request.current = undefined;
        }
        setError(homeworkError(submitError, "Homework could not be submitted. Your response and uploaded attachment are kept for retry."));
      }
    } finally { inFlight.current = false; if (!controller.signal.aborted) setPhase(undefined); }
  }

  async function removeSelected() {
    if (inFlight.current || phase) return;
    inFlight.current = true; setPhase("removing"); setError("");
    try {
      if (uploaded) await discardPendingHomeworkFile(client, uploaded.path);
      setFile(undefined); setUploaded(undefined); if (input.current) input.current.value = "";
      request.current = undefined; dirty.current = true;
    } catch (removeError) { setError(homeworkError(removeError, "The selected attachment could not be removed. Refresh its saved status before trying again.")); }
    finally { inFlight.current = false; setPhase(undefined); }
  }

  async function download() {
    if (!snapshot?.file_path || downloading || sessionChanged) return;
    const controller = new AbortController(); downloadController.current = controller;
    setDownloading(true); setError("");
    try { await downloadHomeworkFile(client, snapshot.id, snapshot.file_name ?? undefined, controller.signal); }
    catch (downloadError) {
      if (!controller.signal.aborted && (downloadError as { name?: string })?.name !== "AbortError") setError(homeworkError(downloadError, "The attachment could not be downloaded. Refresh your access before trying again."));
    } finally {
      if (downloadController.current === controller) downloadController.current = undefined;
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  return <section className="mt-4 min-w-0 space-y-3 border-t border-[var(--border)] pt-4" aria-label="My homework submission">
    <button type="button" className={action} aria-expanded={open} aria-controls={panelId} onClick={() => { if (open) { downloadController.current?.abort(); setDownloading(false); } else if (!sessionChanged) void load(); setOpen((value) => !value); }} disabled={Boolean(phase)}>{open ? "Hide my submission" : "My submission"}</button>
    {open && <div id={panelId} className="min-w-0 space-y-3">
      {sessionChanged ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reopen Homework before continuing.</p> : <>
        <div className="flex flex-wrap items-center justify-between gap-2">{loading ? <LoadingState variant="form" label="Checking submission…" /> : <p className="text-sm font-semibold">{snapshot === undefined ? "Status unavailable" : snapshot ? snapshot.status === "graded" ? "Graded" : "Submitted" : "Not submitted"}</p>}
          <button type="button" className={action} disabled={loading || Boolean(phase)} onClick={() => { setMessage(""); void load(); }}>Refresh submission status</button></div>
        {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        {snapshot && <div className="space-y-2 rounded-xl bg-[var(--surface-2)] p-3 text-sm">
          <p>Saved {new Date(snapshot.submitted_at).toLocaleString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata", timeStyle: "short" })} IST</p>
          {snapshot.file_path && <button type="button" className={`${action} max-w-full break-all text-left`} disabled={downloading} onClick={() => void download()}>{downloading ? "Downloading attachment…" : `Download attachment${snapshot.file_name ? ` · ${snapshot.file_name}` : ""}`}</button>}
          {graded && <><p className="font-semibold">Marks: {snapshot.marks === null ? "Feedback only" : `${snapshot.marks}${typeof maxMarks === "number" ? ` / ${maxMarks}` : ""}`}</p><p className="whitespace-pre-wrap">{snapshot.feedback || "No written feedback."}</p></>}
        </div>}
        <form aria-label="Submit my homework" onSubmit={submit} className="space-y-3">
          <label htmlFor={responseId} className="block text-sm font-semibold">Your response</label>
          <textarea id={responseId} maxLength={10000} rows={4} value={response} disabled={graded || Boolean(phase) || snapshot === undefined || loading} className="field w-full min-w-0" onChange={(event) => { setResponse(event.target.value); dirty.current = true; request.current = undefined; setMessage(""); }} />
          {!graded && !snapshot?.file_path && <div className="space-y-2">
            <label htmlFor={fileId} className="block text-sm font-semibold">Homework attachment (optional)</label>
            <input ref={input} id={fileId} type="file" accept={HOMEWORK_FILE_ACCEPT} disabled={Boolean(phase) || Boolean(uploaded) || snapshot === undefined || loading} className="block min-h-11 w-full min-w-0 max-w-full text-sm file:mr-3 file:min-h-11 file:rounded-xl file:border file:border-[var(--border)] file:bg-[var(--surface-2)] file:px-3 file:text-sm file:font-semibold" onChange={(event) => {
              const selected = event.target.files?.[0]; if (!selected) return;
              try { validateHomeworkFile(selected); setFile(selected); setUploaded(undefined); dirty.current = true; setError(""); setMessage(""); request.current = undefined; }
              catch (validationError) { event.target.value = ""; setError(homeworkError(validationError, "Choose a PDF, JPG or PNG up to 10 MiB.")); }
            }} />
            <p className="text-xs muted">PDF, JPG or PNG · up to 10 MiB. Attachments stay private and cannot be replaced after submission.</p>
            {file && <div className="flex flex-wrap items-center gap-2 text-sm"><span className="min-w-0 break-all">{uploaded ? "Uploaded and ready to submit" : "Selected"}: {file.name}</span><button type="button" className={action} disabled={Boolean(phase)} onClick={() => void removeSelected()}>{phase === "removing" ? "Removing attachment…" : "Remove selected attachment"}</button></div>}
          </div>}
          {graded ? <p className="text-sm muted">This submission has been graded and is read-only.</p> : <button type="submit" className={`${action} bg-blue-700 text-white`} disabled={Boolean(phase) || loading || snapshot === undefined || conflict || (!response.trim() && !file && !uploaded && !snapshot?.file_path)}>{phase === "uploading" ? "Uploading attachment…" : phase === "submitting" ? "Submitting homework…" : snapshot ? "Update submission" : "Submit homework"}</button>}
        </form>
      </>}
    </div>}
  </section>;
}
