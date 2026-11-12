"use client";

import Link from "next/link";
import { Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck, Unplug, Users } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";
import { createGateDeviceIntent, GateOperationsError, gateReasonLabels, loadGateEvents, loadGateSetup, saveGateOperation, searchGatePupils, type GateEvents, type GateOperation, type GatePupil, type GatePupils, type GateSetup } from "@/lib/attendance/gate-operations";

type Props = { schoolId: string; userId: string; onBusyChange?: (busy: boolean) => void; onReviewAttendance?: () => void };
type Revoke = { kind: "revoke_device"; deviceId: string; label: string } | { kind: "revoke_mapping"; mappingId: string; label: string };
const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" });
const dateTime = (value: string) => `${clock.format(new Date(value))} IST`;
const dateLabel = (value: string) => day.format(new Date(`${value}T00:00:00Z`));
const safeReason = (value: string) => value.trim().length >= 5 && value.trim().length <= 300 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const identifier = (value: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(value);

export function GateOperationsWorkspace(props: Props) {
  const [client] = useState(createClient);
  return <OwnGateOperationsWorkspace key={`${props.userId}:${props.schoolId}`} {...props} client={client} />;
}
function OwnGateOperationsWorkspace({ client, userId, schoolId, onBusyChange, onReviewAttendance }: Props & { client: ReturnType<typeof createClient> }) {
  const [revision, setRevision] = useState(0), [mappingOffset, setMappingOffset] = useState(0), [eventOffset, setEventOffset] = useState(0);
  const [setupRead, setSetupRead] = useState<{ key: string; data: GateSetup }>(), [eventsRead, setEventsRead] = useState<{ key: string; data: GateEvents }>();
  const [name, setName] = useState(""), [lateAfter, setLateAfter] = useState(""), [workingDays, setWorkingDays] = useState<number[]>([]);
  const [query, setQuery] = useState(""), [pupils, setPupils] = useState<GatePupils>(), [selected, setSelected] = useState<GatePupil>(), [subjectId, setSubjectId] = useState("");
  const [searching, setSearching] = useState(false), [revoke, setRevoke] = useState<Revoke>(), [reason, setReason] = useState("");
  const [intent, setIntent] = useState<GateOperation>(), [saving, setSaving] = useState(false), [credential, setCredential] = useState<{ deviceId: string; secret: string }>(), [revealed, setRevealed] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false), [blocked, setBlocked] = useState<string>(), [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const setupController = useRef<AbortController | null>(null), eventsController = useRef<AbortController | null>(null), searchController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null), busyCallback = useRef(onBusyChange);
  const id = useId(), setupKey = `${revision}:${mappingOffset}`, eventsKey = `${revision}:${eventOffset}`;
  const setup = setupRead?.key === setupKey ? setupRead.data : undefined, events = eventsRead?.key === eventsKey ? eventsRead.data : undefined;
  const active = setup?.devices.find(device => device.revoked_at === null), frozen = !!intent;
  const locked = saving || frozen || !!credential || !!revoke || !!name || !!lateAfter || workingDays.length > 0 || !!selected || !!subjectId;
  function abortReads() { setupController.current?.abort(); eventsController.current?.abort(); searchController.current?.abort(); }
  function discardDrafts() { setName(""); setLateAfter(""); setWorkingDays([]); setQuery(""); setPupils(undefined); setSelected(undefined); setSubjectId(""); setRevoke(undefined); setReason(""); }
  function clearSensitive() { setIntent(undefined); setCredential(undefined); setRevealed(false); }
  function invalidate(message: string) {
    abortReads(); writeController.current?.abort(); writeController.current = null; setSaving(false); setSearching(false); clearSensitive(); discardDrafts(); setSetupRead(undefined); setEventsRead(undefined); setNotice(undefined); setBlocked(message);
  }
  function reload() { if (locked) return; abortReads(); setBlocked(undefined); setNotice(undefined); setRevision(value => value + 1); }
  useEffect(() => { busyCallback.current = onBusyChange; onBusyChange?.(locked); }, [locked, onBusyChange]);
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { invalidate("Your sign-in changed. Reopen Attendance to check gate access."); setSessionChanged(true); }
    });
    return () => { setupController.current?.abort(); eventsController.current?.abort(); searchController.current?.abort(); writeController.current?.abort(); subscription.unsubscribe(); busyCallback.current?.(false); };
    // The owner key recreates this workspace when the school or signed-in account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId]);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      const hadSetupSecret = credential !== undefined || intent?.kind === "create_device", hadAction = intent !== undefined;
      abortReads(); writeController.current?.abort(); writeController.current = null; setSaving(false); setSearching(false); clearSensitive(); discardDrafts(); setBlocked(undefined); setRevision(value => value + 1);
      if (hadSetupSecret) setNotice({ error: true, text: "Gate access refreshed and the one-time secret was cleared. If setup was submitted, check its saved device; revoke and recreate it if the secret was not saved." });
      else if (hadAction) setNotice({ error: true, text: "Gate access refreshed. The previous action may already have completed; review saved setup before starting another change." });
    };
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
    // Refresh invalidates every draft rather than carrying credentials across a changed access context.
  }, [credential, intent]);
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [locked]);
  useEffect(() => {
    if (sessionChanged || blocked) return;
    const controller = new AbortController(); setupController.current = controller;
    loadGateSetup(client, userId, schoolId, mappingOffset, controller.signal).then(data => { if (!controller.signal.aborted) setSetupRead({ key: setupKey, data }); }, (failure: unknown) => {
      if (!controller.signal.aborted) invalidate(failure instanceof GateOperationsError ? failure.message : "Gate setup could not be verified. Retry the access check.");
    });
    return () => { controller.abort(); if (setupController.current === controller) setupController.current = null; };
    // Access failure deliberately invalidates both independent reads and all credential state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId, schoolId, mappingOffset, setupKey, blocked, sessionChanged]);
  useEffect(() => {
    if (sessionChanged || blocked) return;
    const controller = new AbortController(); eventsController.current = controller;
    loadGateEvents(client, userId, schoolId, eventOffset, controller.signal).then(data => { if (!controller.signal.aborted) setEventsRead({ key: eventsKey, data }); }, (failure: unknown) => {
      if (!controller.signal.aborted) invalidate(failure instanceof GateOperationsError ? failure.message : "Gate events could not be verified. Retry the access check.");
    });
    return () => { controller.abort(); if (eventsController.current === controller) eventsController.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId, schoolId, eventOffset, eventsKey, blocked, sessionChanged]);
  async function search(searchQuery = query.trim(), offset = 0) {
    if (saving || frozen || credential || !active || searchQuery.length < 2) return;
    searchController.current?.abort(); const controller = new AbortController(); searchController.current = controller; setSearching(true); setPupils(undefined); setSelected(undefined); setNotice(undefined);
    try { const data = await searchGatePupils(client, userId, schoolId, searchQuery, offset, controller.signal); if (!controller.signal.aborted) setPupils(data); }
    catch (failure) { if (!controller.signal.aborted) invalidate(failure instanceof GateOperationsError ? failure.message : "Student access could not be verified. Retry the access check."); }
    finally { if (searchController.current === controller) { searchController.current = null; if (!controller.signal.aborted) setSearching(false); } }
  }
  async function run(next: GateOperation) {
    if (writeController.current || saving || sessionChanged || blocked || credential || !setup) return;
    const controller = new AbortController(); writeController.current = controller; abortReads(); setIntent(next); setSaving(true); setSearching(false); setNotice(undefined);
    try {
      const saved = await saveGateOperation(client, userId, next, controller.signal);
      if (controller.signal.aborted) return;
      setIntent(undefined); discardDrafts(); setMappingOffset(0); setEventOffset(0); setRevision(value => value + 1);
      if (next.kind === "create_device" && saved.revoked_at === null) { setCredential({ deviceId: next.deviceId, secret: next.secret }); setRevealed(false); setNotice({ error: false, text: "Gate device registered. Reveal and save its one-time setup secret before leaving this page." }); }
      else setNotice({ error: false, text: next.kind === "create_device" || next.kind === "map_student" ? saved.revoked_at ? "The saved setup is already revoked and is not active. Review current device history." : "Student identifier linked. Existing attendance history is unchanged." : "Gate access revoked. Existing scan and attendance history is unchanged." });
    } catch (failure) {
      if (controller.signal.aborted) return;
      const error = failure instanceof GateOperationsError ? failure : new GateOperationsError("The action outcome could not be confirmed. Retry the same frozen gate action.");
      if (error.code === "unconfirmed") setNotice({ error: true, text: error.message }); else invalidate(error.message);
    } finally { if (writeController.current === controller) { writeController.current = null; if (!controller.signal.aborted) setSaving(false); } }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || name.trim().length > 80 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(lateAfter) || !workingDays.length || active || saving || frozen) return;
    try { void run(createGateDeviceIntent(schoolId, name.trim(), lateAfter, workingDays)); } catch { setNotice({ error: true, text: "A secure device secret could not be generated. Reload before registering a device." }); }
  }
  function map(event: FormEvent) {
    event.preventDefault(); if (!active || !selected || !identifier(subjectId.trim()) || saving || frozen) return;
    try { void run({ kind: "map_student", schoolId, deviceId: active.device_id, mappingId: crypto.randomUUID(), subjectId: subjectId.trim(), studentId: selected.student_id }); }
    catch { setNotice({ error: true, text: "A secure mapping identifier could not be generated. Reload before linking a pupil." }); }
  }
  function confirmRevoke(event: FormEvent) {
    event.preventDefault(); if (!revoke || !safeReason(reason) || saving || frozen) return;
    void run(revoke.kind === "revoke_device" ? { kind: revoke.kind, schoolId, deviceId: revoke.deviceId, reason: reason.trim() } : { kind: revoke.kind, schoolId, mappingId: revoke.mappingId, reason: reason.trim() });
  }
  const operationsDisabled = saving || frozen || !!credential || !!revoke;
  return <section className="min-w-0 space-y-4" aria-labelledby={`${id}-title`}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`${id}-title`} className="flex items-center gap-2 text-xl font-bold"><ShieldCheck size={20} aria-hidden="true" />Gate operations</h2><p className="mt-1 max-w-3xl text-sm leading-6 muted">Manage one school gate device, student identifiers and retained IN/OUT receipts.</p></div><button type="button" className={control} disabled={locked || sessionChanged} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Refresh gate access</button></header>
    {notice && !sessionChanged && <p role={notice.error ? "alert" : "status"} className={`rounded-xl border p-3 text-sm leading-6 ${notice.error ? "border-red-500/20 text-red-700 dark:text-red-300" : "border-[var(--border)] text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>}
    {sessionChanged ? <p role="alert" className="card p-4 text-sm">Your sign-in changed. Reopen Attendance to check gate access.</p>
      : blocked ? <div className="card space-y-3 p-4"><p role="alert" className="text-sm text-red-700 dark:text-red-300">{blocked}</p><div className="flex flex-wrap gap-3"><button type="button" className={control} onClick={reload}>Retry gate access</button><Link href="/account/settings" className={`${control} text-[var(--primary)]`}>Account security</Link></div><p className="text-xs leading-5 muted">Any one-time secret has been cleared. If a submitted device setup was not confirmed, inspect its saved device and revoke/recreate it before use.</p></div>
        : <>
          {credential && <section aria-label="One-time device credentials" className="card space-y-3 border-[var(--primary)]/30 p-4"><h3 className="flex items-center gap-2 font-semibold"><KeyRound size={17} aria-hidden="true" />Save device setup credentials</h3><p className="text-xs leading-5 muted">The secret is available only in this session. Returning focus, reloading or changing accounts clears it. Save it securely for the gate installer; revoke and recreate the device if it is lost.</p><label className="block space-y-2 text-sm font-semibold"><span>Device ID</span><input className="field font-mono text-xs" readOnly value={credential.deviceId} /></label><label className="block space-y-2 text-sm font-semibold"><span>Device secret</span><input className="field font-mono text-xs" type={revealed ? "text" : "password"} readOnly autoComplete="off" spellCheck={false} value={credential.secret} /></label><div className="flex flex-wrap gap-2"><button type="button" className={control} onClick={() => setRevealed(value => !value)}>{revealed ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}{revealed ? "Hide device secret" : "Reveal device secret"}</button><button type="button" className={control} onClick={() => { setCredential(undefined); setRevealed(false); }}>I saved the credentials</button></div><p className="text-xs leading-5 muted">Reveal the secret, select its text and copy manually. Nothing is copied to the clipboard automatically.</p></section>}
          {intent && !saving && <section aria-label="Unconfirmed gate action" className="card space-y-3 p-4"><h3 className="font-semibold">Confirm the previous action</h3><p className="text-sm leading-6 muted">The server may have saved it. Retry the same frozen action; do not generate a replacement setup. {intent.kind === "create_device" && "Reloading loses the generated secret. If the saved device is then active, revoke and recreate it before use."}</p><button type="button" className={control} onClick={() => void run(intent)}>Retry same gate action</button></section>}
          {revoke && <form aria-label="Revoke gate access" onSubmit={confirmRevoke} className="card space-y-3 p-4"><h3 className="flex items-center gap-2 font-semibold"><Unplug size={17} aria-hidden="true" />Revoke {revoke.label}</h3><p className="text-xs leading-5 muted">This stops new use of this access. Saved scan receipts and attendance remain in history.</p><label className="block space-y-2 text-sm font-semibold"><span>Revocation reason</span><textarea className="field min-h-24" autoFocus aria-describedby={`${id}-reason-hint`} value={reason} minLength={5} maxLength={300} required disabled={saving || frozen} onChange={event => setReason(event.target.value)} /></label><span id={`${id}-reason-hint`} className="-mt-2 block text-xs font-normal muted">At least 5 characters.</span><div className="flex flex-wrap gap-2"><button type="submit" className="btn btn-danger-solid" disabled={saving || frozen || !safeReason(reason)}>{saving ? "Revoking…" : "Confirm revocation"}</button><button type="button" className={control} disabled={saving || frozen} onClick={() => { setRevoke(undefined); setReason(""); }}>Cancel revocation</button></div></form>}
          {!setup ? <LoadingState variant="form">Loading gate setup…</LoadingState> : <>
            <div className="grid items-start gap-4 xl:grid-cols-2">
              <section aria-label="Gate device setup" className="card min-w-0 space-y-4 p-4"><header><h3 className="font-semibold">{active ? "Active gate device" : "Register a gate device"}</h3><p className="mt-1 text-xs leading-5 muted">One active device per school. School time is Asia/Kolkata.</p></header>
                {active ? <div className="space-y-3"><div className="rounded-xl bg-[var(--surface-2)] p-3"><p className="break-words text-sm font-semibold">{active.name}</p><p className="mt-1 break-all font-mono text-xs muted">{active.device_id}</p><p className="mt-2 text-xs leading-5 muted">Late after {active.late_after} IST · Fallback: {active.working_days.map(value => weekdays[value].slice(0, 3)).join(", ")}</p></div><button type="button" className="btn btn-danger" disabled={operationsDisabled || !!name || !!lateAfter || workingDays.length > 0 || !!selected || !!subjectId} onClick={() => { setRevoke({ kind: "revoke_device", deviceId: active.device_id, label: active.name }); setReason(""); }}>Revoke active device</button></div>
                  : <form aria-label="Register gate device" onSubmit={create} className="space-y-4"><fieldset className="min-w-0 space-y-3" disabled={operationsDisabled}><label className="block space-y-2 text-sm font-semibold"><span>Device name</span><input className="field" value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></label><label className="block space-y-2 text-sm font-semibold"><span>Late arrival cutoff (IST)</span><input type="time" step={60} className="field" value={lateAfter} required onChange={event => setLateAfter(event.target.value)} /></label><fieldset className="space-y-2"><legend className="text-sm font-semibold">Fallback working weekdays</legend><p className="text-xs leading-5 muted">Used only when this date has no configured school calendar. The approved school calendar takes precedence.</p><div className="flex flex-wrap gap-x-4 gap-y-1">{weekdays.map((label, value) => <label key={label} className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={workingDays.includes(value)} onChange={event => setWorkingDays(previous => event.target.checked ? [...previous, value].sort((a, b) => a - b) : previous.filter(day => day !== value))} />{label}</label>)}</div></fieldset><div className="flex flex-wrap gap-2"><button type="submit" className={control} disabled={!name.trim() || !lateAfter || !workingDays.length}>{saving && intent?.kind === "create_device" ? "Registering…" : "Register device"}</button><button type="button" className={control} onClick={() => { setName(""); setLateAfter(""); setWorkingDays([]); }}>Cancel setup draft</button></div></fieldset></form>}
                <Link href="/modules/settings#attendance-calendar" className="inline-flex min-h-11 items-center text-xs font-semibold text-[var(--primary)] underline">Configure school calendar</Link>
              </section>
              <section aria-label="Map student identifier" className="card min-w-0 space-y-4 p-4"><header><h3 className="flex items-center gap-2 font-semibold"><Users size={17} aria-hidden="true" />Student identifier mapping</h3><p className="mt-1 text-xs leading-5 muted">Search and explicitly select an active pupil. Identifiers are exact and cannot be silently reused.</p></header>{!active ? <p className="text-sm muted">Register an active school device before linking student identifiers.</p> : <>
                <form aria-label="Search gate pupils" className="space-y-2" onSubmit={event => { event.preventDefault(); void search(); }}><label className="block space-y-2 text-sm font-semibold"><span>Admission number or pupil name</span><input className="field" value={query} minLength={2} maxLength={80} disabled={operationsDisabled} onChange={event => { searchController.current?.abort(); setSearching(false); setQuery(event.target.value); setPupils(undefined); setSelected(undefined); }} /></label><button type="submit" className={control} disabled={operationsDisabled || searching || query.trim().length < 2}>{searching ? "Searching…" : "Search pupils"}</button></form>
                {searching ? <LoadingState variant="list">Searching active pupils…</LoadingState> : pupils && <div className="space-y-2"><p className="text-xs muted">{pupils.total_count ? `Showing ${pupils.offset + 1}–${pupils.offset + pupils.pupils.length} of ${pupils.total_count} matches` : "No active pupils match this search."}</p><ul className="space-y-2" aria-label="Matching pupils">{pupils.pupils.map(pupil => <li key={pupil.student_id}><button type="button" aria-pressed={selected?.student_id === pupil.student_id} disabled={operationsDisabled} className={`${control} w-full flex-col items-start text-left`} onClick={() => setSelected(pupil)}><span className="break-words">{pupil.student_name}</span><span className="break-words text-xs font-normal muted">{pupil.admission_no}</span></button></li>)}</ul>{pupils.total_count > 25 && <div className="flex flex-wrap gap-2"><button type="button" className={control} aria-label="Previous pupil matches" disabled={operationsDisabled || searching || pupils.offset === 0} onClick={() => void search(pupils.query, Math.max(0, pupils.offset - 25))}>Previous</button><button type="button" className={control} aria-label="Next pupil matches" disabled={operationsDisabled || searching || pupils.offset + pupils.pupils.length >= pupils.total_count} onClick={() => void search(pupils.query, pupils.offset + 25)}>Next</button></div>}</div>}
                <form aria-label="Link gate student" onSubmit={map} className="space-y-3"><fieldset className="min-w-0 space-y-3" disabled={operationsDisabled}><p className="text-xs leading-5 muted">{selected ? `Selected: ${selected.student_name} · ${selected.admission_no}` : "Select a pupil from the search results before linking."}</p><label className="block space-y-2 text-sm font-semibold"><span>Device student identifier</span><input className="field font-mono text-sm" value={subjectId} maxLength={128} pattern="[A-Za-z0-9._:-]{1,128}" required onChange={event => setSubjectId(event.target.value)} /></label><div className="flex flex-wrap gap-2"><button type="submit" className={control} disabled={!selected || !identifier(subjectId.trim())}>{saving && intent?.kind === "map_student" ? "Linking…" : "Link selected pupil"}</button><button type="button" className={control} onClick={() => { searchController.current?.abort(); setQuery(""); setPupils(undefined); setSelected(undefined); setSubjectId(""); setSearching(false); }}>Cancel mapping draft</button></div></fieldset></form>
              </>}
              </section>
            </div>
            <section aria-label="Gate student mappings" className="card min-w-0 space-y-3 p-4"><header><h3 className="font-semibold">Student identifiers</h3><p className="mt-1 text-xs leading-5 muted">Retained mappings across device history. Revocation never deletes a saved scan or attendance mark.</p></header>{setup.mappings.length ? <ul className="divide-y divide-[var(--border)]">{setup.mappings.map(mapping => <li key={mapping.mapping_id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-3"><div className="min-w-0"><p className="break-words text-sm font-semibold">{mapping.student_name} · {mapping.admission_no}</p><p className="mt-1 break-all font-mono text-xs">{mapping.subject_id}</p><p className="mt-1 break-all text-xs leading-5 muted">Device {mapping.device_id} · Valid from {dateLabel(mapping.valid_from)} · {mapping.revoked_at ? `Revoked ${dateTime(mapping.revoked_at)}` : mapping.device_id === active?.device_id ? "Active" : "Device inactive"}</p></div>{mapping.revoked_at === null && <button type="button" className="btn btn-danger" aria-label={`Revoke identifier ${mapping.subject_id} on device ${mapping.device_id}`} disabled={locked} onClick={() => { setRevoke({ kind: "revoke_mapping", mappingId: mapping.mapping_id, label: `identifier ${mapping.subject_id}` }); setReason(""); }}>Revoke identifier</button>}</li>)}</ul> : <p className="text-sm muted">No mappings on this page.</p>}<div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3"><p className="text-xs muted">{setup.mappings.length ? `${setup.offset + 1}–${setup.offset + setup.mappings.length} of ${setup.mapping_count} mappings` : `${setup.mapping_count} retained mappings`}</p><div className="flex flex-wrap gap-2"><button type="button" className={control} aria-label="Previous mapping page" disabled={locked || mappingOffset === 0} onClick={() => { searchController.current?.abort(); setPupils(undefined); setSelected(undefined); setMappingOffset(value => Math.max(0, value - 100)); }}>Previous</button><button type="button" className={control} aria-label="Next mapping page" disabled={locked || setup.offset + setup.mappings.length >= setup.mapping_count} onClick={() => { searchController.current?.abort(); setPupils(undefined); setSelected(undefined); setMappingOffset(value => value + 100); }}>Next</button></div></div></section>
            <section aria-label="Gate device history" className="card min-w-0 space-y-3 p-4"><h3 className="font-semibold">Active device and latest retained devices</h3><p className="text-xs leading-5 muted">Showing {setup.devices.length} of {setup.device_count} device records; the active device is always included.</p>{setup.devices.length ? <ul className="grid gap-3 lg:grid-cols-2">{setup.devices.map(device => <li key={device.device_id} className="min-w-0 rounded-xl border border-[var(--border)] p-3"><p className="break-words text-sm font-semibold">{device.name} · {device.revoked_at ? "Revoked" : "Active"}</p><p className="mt-1 break-all font-mono text-xs muted">{device.device_id}</p><p className="mt-2 text-xs leading-5 muted">Created {dateTime(device.created_at)}{device.revoked_at && ` · Revoked ${dateTime(device.revoked_at)}`}</p></li>)}</ul> : <p className="text-sm muted">No gate device has been registered.</p>}</section>
          </>}
          <section aria-label="Gate event receipts" className="card min-w-0 space-y-3 p-4"><header><h3 className="font-semibold">Gate IN/OUT receipts</h3><p className="mt-1 text-xs leading-5 muted">Immutable received events, not the current attendance register. Held scans are not applied. A reviewed attendance correction does not change these immutable receipts.</p></header>{!events ? <LoadingState variant="list">Loading gate event receipts…</LoadingState> : <>{events.events.length ? <ul className="divide-y divide-[var(--border)]">{events.events.map(event => <li key={event.receipt_id} className="min-w-0 space-y-2 py-3"><div className="flex flex-wrap items-start justify-between gap-2"><p className="min-w-0 break-words text-sm font-semibold">{event.student_name ?? "Unlinked student"}{event.admission_no ? ` · ${event.admission_no}` : ""}</p><span className={`badge ${event.status === "accepted" ? "text-success" : "text-warning"}`}>{event.direction} · {event.status === "accepted" ? "Accepted" : "Held for review"}</span></div><p className="text-xs leading-5 muted"><time dateTime={event.occurred_at}>{dateTime(event.occurred_at)}</time> · {gateReasonLabels[event.reason] ?? "School review required"}</p><p className="break-all text-xs leading-5 muted">{event.device_name ?? "Retained device"} · Identifier {event.subject_id} · Event {event.event_id}</p><p className="text-xs leading-5 muted">Received {dateTime(event.received_at)}{event.attendance_status ? ` · Receipt attendance: ${event.attendance_status.replaceAll("_", " ")}` : ""}</p>{event.status === "held_review" && onReviewAttendance && <button type="button" disabled={locked} onClick={onReviewAttendance} className={`${control} text-xs text-[var(--primary)]`}>Open attendance review</button>}</li>)}</ul> : <p className="text-sm muted">No received gate events on this page.</p>}<div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3"><p className="text-xs muted">{events.events.length ? `${events.offset + 1}–${events.offset + events.events.length} of ${events.total_count} receipts` : `${events.total_count} retained receipts`}</p><div className="flex flex-wrap gap-2"><button type="button" className={control} aria-label="Previous gate event page" disabled={locked || eventOffset === 0} onClick={() => setEventOffset(value => Math.max(0, value - 100))}>Previous</button><button type="button" className={control} aria-label="Next gate event page" disabled={locked || events.offset + events.events.length >= events.total_count} onClick={() => setEventOffset(value => value + 100)}>Next</button></div></div></>}</section>
        </>}
  </section>;
}
