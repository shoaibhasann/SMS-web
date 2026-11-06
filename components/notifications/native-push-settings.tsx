"use client";

import { BellRing, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LoadingState } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { loadNativePushSettings, NativePushError, revokeNativePushDevice, saveNativePushPreferences,
  type NativePushPreferences, type NativePushRole, type NativePushSettings as Settings } from "@/lib/notifications/native-push";

type Props = { userId: string; roles: readonly NativePushRole[] };
type Result = { data: Settings } | { error: string };
type Notice = { error: boolean; text: string };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-50";
const primary = `${button} border-transparent bg-[var(--primary)] text-white dark:text-slate-950`;
const eventLabels = { absence: "Absent attendance", result_published: "Published results", leave_decision: "Leave decisions" } as const;
const roleLabels = { parent: "Guardian", student: "Student" };
const times = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const same = (a: NativePushPreferences, b: NativePushPreferences) => a.enabled === b.enabled && a.absence === b.absence
  && a.result_published === b.result_published && a.leave_decision === b.leave_decision;
const errorText = (error: unknown, fallback: string) => error instanceof NativePushError ? error.message : fallback;

export function NativePushSettings({ userId, roles }: Props) {
  const available = [...new Set(roles.filter((role) => role === "parent" || role === "student"))];
  if (!available.length) return null;
  return <OwnNativePushSettings key={`${userId}:${available.join(":")}`} userId={userId} roles={available} />;
}

function OwnNativePushSettings({ userId, roles }: Props) {
  const [client] = useState(createClient), [role, setRole] = useState(roles[0]);
  const [version, setVersion] = useState(0), [loaded, setLoaded] = useState<{ key: string; result: Result }>();
  const [draft, setDraft] = useState<NativePushPreferences>();
  const [sessionChanged, setSessionChanged] = useState(false), [busy, setBusy] = useState<"save" | "revoke">();
  const [notice, setNotice] = useState<Notice>(), [confirmDevice, setConfirmDevice] = useState<string>();
  const readRequest = useRef<AbortController | null>(null), writeRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), confirmButton = useRef<HTMLButtonElement>(null), revokeTrigger = useRef<HTMLButtonElement | null>(null);
  const returnToDevice = useRef<string | undefined>(undefined);
  const id = useId(), key = `${role}:${version}`;
  const result = loaded?.key === key ? loaded.result : undefined;
  const settings = result && "data" in result ? result.data : undefined;
  const dirty = !!settings && !!draft && !same(settings.preferences, draft);

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { readRequest.current?.abort(); writeRequest.current?.abort(); setSessionChanged(true); }
    });
    return () => { readRequest.current?.abort(); writeRequest.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId]);
  useEffect(() => {
    if (sessionChanged) return;
    const controller = new AbortController(); readRequest.current = controller;
    loadNativePushSettings(client, role, controller.signal).then((data) => {
      if (!controller.signal.aborted) { setLoaded({ key, result: { data } }); setDraft(data.preferences); }
    }, (error: unknown) => {
      if (!controller.signal.aborted) setLoaded({ key, result: { error: errorText(error, "Mobile notification settings could not be loaded. Refresh to try again.") } });
    });
    return () => { controller.abort(); if (readRequest.current === controller) readRequest.current = null; };
  }, [client, role, key, sessionChanged]);
  useEffect(() => {
    if (confirmDevice) confirmButton.current?.focus();
    else if (returnToDevice.current) { revokeTrigger.current?.focus(); returnToDevice.current = undefined; }
  }, [confirmDevice]);

  function discard() {
    return !dirty || window.confirm("Discard your unsaved mobile notification preferences?");
  }
  function refresh() {
    if (busy || !discard()) return;
    setNotice(undefined); setConfirmDevice(undefined); setVersion((value) => value + 1);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sessionChanged || writeRequest.current || !settings || !draft || !dirty) return;
    const controller = new AbortController(); writeRequest.current = controller; setBusy("save"); setNotice(undefined); setConfirmDevice(undefined);
    try {
      const data = await saveNativePushPreferences(client, role, draft, controller.signal);
      if (!controller.signal.aborted) { setLoaded({ key, result: { data } }); setDraft(data.preferences); setNotice({ error: false, text: "Mobile push preferences saved. A registered app device and enabled school delivery setup are required to receive alerts." }); }
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ error: true, text: errorText(error, "The save could not be confirmed. Your selection is kept. Refresh to check the saved settings before retrying.") });
    } finally {
      if (writeRequest.current === controller) { writeRequest.current = null; if (!controller.signal.aborted) setBusy(undefined); }
    }
  }
  async function revoke(deviceId: string) {
    if (sessionChanged || writeRequest.current || !settings?.devices.some((device) => device.id === deviceId)) return;
    const controller = new AbortController(); writeRequest.current = controller; setBusy("revoke"); setNotice(undefined);
    try {
      const confirmed = await revokeNativePushDevice(client, role, deviceId, controller.signal);
      if (controller.signal.aborted) return;
      const data = await loadNativePushSettings(client, role, controller.signal);
      if (controller.signal.aborted) return;
      setLoaded({ key, result: { data } });
      if (!dirty) setDraft(data.preferences);
      setConfirmDevice(undefined); heading.current?.focus({ preventScroll: true });
      setNotice({ error: !confirmed, text: confirmed ? "Device revoked. Future mobile pushes will stop for this device. Alerts already shown on a phone cannot be recalled." : "This device is no longer available. Its current saved state has been refreshed." });
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ error: true, text: errorText(error, "The revocation could not be confirmed. Refresh to check the saved device state before retrying.") });
    } finally {
      if (writeRequest.current === controller) { writeRequest.current = null; if (!controller.signal.aborted) setBusy(undefined); }
    }
  }

  return <section className="card overflow-hidden" aria-labelledby={`${id}-heading`} aria-busy={!sessionChanged && !result}>
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-5 sm:p-6">
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><BellRing size={19} aria-hidden="true" /><h2 id={`${id}-heading`} ref={heading} tabIndex={-1} className="font-semibold">Mobile push notifications</h2></div>
        <p className="mt-2 text-sm leading-6 muted">Prepare your mobile app preferences and manage your own registered phones. The native app is coming in a later phase.</p></div>
      <button type="button" className={button} disabled={!!busy || sessionChanged} onClick={refresh} aria-label="Refresh push settings"><RefreshCw size={16} aria-hidden="true" />Refresh</button>
    </header>
    {sessionChanged ? <p role="alert" className="p-5 text-sm muted">Your sign-in changed. Reopen settings to manage mobile notifications.</p>
      : <div className="space-y-5 p-5 sm:p-6">
        {roles.length > 1 && <label className="block max-w-xs space-y-2 text-sm font-semibold"><span>Notification account view</span><select className="field" value={role} disabled={!!busy} onChange={(event) => {
          const next = event.target.value as NativePushRole;
          if (!roles.includes(next) || next === role || !discard()) return;
          setRole(next); setConfirmDevice(undefined); setNotice(undefined);
        }}>{roles.map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}</select></label>}
        {!result ? <LoadingState variant="form">Loading mobile notification settings…</LoadingState>
          : "error" in result ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{result.error}</p>
            : settings && draft && <>
              {notice && <p role={notice.error ? "alert" : "status"} className={`rounded-xl p-4 text-sm ${notice.error ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>}
              <form aria-label="Mobile push preferences" className="space-y-4" onSubmit={(event) => void save(event)}>
                <fieldset disabled={!!busy} className="space-y-4"><legend className="sr-only">Mobile push preferences</legend>
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] p-4"><input type="checkbox" className="mt-1 size-4 accent-[var(--primary)]" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
                    <span><span className="block text-sm font-semibold">Allow mobile push notifications</span><span className="mt-1 block text-xs leading-5 muted">App notifications require your phone’s permission and a registered app device. Your in-app notifications keep their own read state.</span></span></label>
                  <div className={`grid gap-3 ${role === "student" ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>{(Object.keys(eventLabels) as (keyof typeof eventLabels)[]).filter((kind) => role === "parent" || kind !== "absence").map((kind) => <label key={kind} className="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-3 text-sm"><input type="checkbox" className="size-4 shrink-0 accent-[var(--primary)]" checked={draft[kind]} onChange={(event) => setDraft({ ...draft, [kind]: event.target.checked })} />{eventLabels[kind]}</label>)}</div>
                  {role === "student" && <p className="text-xs leading-6 muted">Student app alerts currently cover published results and leave decisions.</p>}
                  <div className="flex flex-wrap items-center gap-3"><button type="submit" className={primary} disabled={!dirty}>{busy === "save" ? "Saving preferences…" : "Save push preferences"}</button><span className="text-xs muted">{dirty ? "Unsaved changes" : "Saved preferences"}</span></div>
                </fieldset>
              </form>
              <div className="border-t border-[var(--border)] pt-5"><h3 className="flex items-center gap-2 font-semibold"><Smartphone size={18} aria-hidden="true" />Registered devices</h3>
                {!settings.devices.length ? <p className="mt-3 rounded-xl bg-[var(--surface-2)] p-4 text-sm leading-6 muted">No mobile devices linked. Devices will appear after you sign in and enable notifications in the native app.</p>
                  : <ul className="mt-3 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">{settings.devices.map((device) => <li key={device.id} className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words text-sm font-semibold">{device.label}</h4><p className="mt-1 text-xs muted">{device.platform === "ios" ? "iOS" : "Android"} · {device.revoked_at ? "Revoked" : "Registered"}</p><p className="mt-1 text-xs muted">Last registered {times.format(new Date(device.last_seen_at))} IST</p></div>
                      {!device.revoked_at && confirmDevice !== device.id && <button ref={(node) => { if (returnToDevice.current === device.id) revokeTrigger.current = node; }} type="button" className={button} disabled={!!busy} aria-label={`Revoke device: ${device.label}`} onClick={(event) => { returnToDevice.current = device.id; revokeTrigger.current = event.currentTarget; setConfirmDevice(device.id); setNotice(undefined); }}>Revoke</button>}</div>
                    {confirmDevice === device.id && !device.revoked_at && <div role="group" aria-label={`Confirm revoke ${device.label}`} className="space-y-3 rounded-xl bg-[var(--surface-2)] p-4"><p className="text-sm leading-6">Stop future mobile pushes to this device? Already displayed alerts cannot be recalled. Your account and school records stay available.</p><div className="flex flex-wrap gap-2"><button ref={confirmButton} type="button" className={button} disabled={!!busy} onClick={() => void revoke(device.id)}>{busy === "revoke" ? "Revoking…" : "Confirm revoke device"}</button><button type="button" className={button} disabled={!!busy} onClick={() => setConfirmDevice(undefined)}>Cancel revocation</button></div></div>}
                  </li>)}</ul>}
              </div>
              <p className="flex items-start gap-2 text-xs leading-6 muted"><ShieldCheck size={15} className="mt-1 shrink-0" aria-hidden="true" />Lock-screen alerts use a neutral message. Open the app and verify your school access to read the permitted record.</p>
            </>}
      </div>}
  </section>;
}
