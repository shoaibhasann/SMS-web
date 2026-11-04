"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AcademicSetup } from "@/lib/admin/academic-setup";

type Year = AcademicSetup["years"][number];
type Readiness = {
  unplaced: number;
  invalid_placements: number;
  pending_corrections: number;
  destination_count: number;
  can_start_today: boolean;
};

const secondary = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60";

export function AcademicYearActivation({ client, schoolId, current, years, saving, setSaving, onActivated }: {
  client: SupabaseClient;
  schoolId: string;
  current: Year;
  years: Year[];
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onActivated: () => void;
}) {
  const laterYears = years.filter((year) => !year.is_current && year.start_date > current.end_date);
  const [selected, setSelected] = useState("");
  const target = laterYears.find((year) => year.id === selected);
  const targetId = target?.id;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ targetId: string; revision: number; data?: Readiness; error?: string }>();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [activationError, setActivationError] = useState("");
  const pending = useRef(false);
  const currentId = current.id;

  useEffect(() => {
    if (!targetId) return;
    let active = true;
    async function load() {
      const { data, error } = await client.rpc("preview_academic_year_activation", {
        p_school_id: schoolId,
        p_previous_year_id: currentId,
        p_academic_year_id: targetId,
      });
      if (!active || !targetId) return;
      setResult(error || !data
        ? { targetId, revision, error: "Could not check session readiness. Refresh checks and try again." }
        : { targetId, revision, data: data as Readiness });
    }
    void load();
    return () => { active = false; };
  }, [client, currentId, revision, schoolId, targetId]);

  const check = result && result.targetId === targetId && result.revision === revision ? result : undefined;
  const readiness = check?.data;
  const ready = readiness?.can_start_today && !readiness.unplaced && !readiness.invalid_placements && !readiness.pending_corrections;

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || saving || !targetId || !ready || !confirmed || reason.trim().length < 5) return;
    pending.current = true;
    setSaving(true);
    setActivationError("");
    try {
      const { data, error } = await client.rpc("activate_academic_year", {
        p_school_id: schoolId,
        p_previous_year_id: currentId,
        p_academic_year_id: targetId,
        p_reason: reason.trim(),
      });
      if (error || data !== targetId) {
        throw new Error(error?.code === "22023" || error?.code === "42501"
          ? error.message
          : "Could not confirm activation. Refresh the academic years to check the current session.");
      }
      onActivated();
    } catch (error) {
      setActivationError(error instanceof Error ? error.message : "Could not confirm activation.");
      setConfirmed(false);
      setRevision((value) => value + 1);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  if (!laterYears.length) return null;
  return (
    <section aria-labelledby="session-activation-title" className="space-y-4 rounded-2xl border border-[var(--border)] p-4 sm:p-5">
      <div>
        <h3 id="session-activation-title" className="font-bold">Activate next academic year</h3>
        <p className="mt-1 text-sm muted">Stage student promotions in Students first. Activation switches the school’s active register from {current.name} to the selected session. Previous attendance and fee records stay in their original sessions.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block w-full max-w-md space-y-1 text-sm font-semibold">
          <span>Destination academic year</span>
          <select className="field" value={selected} disabled={saving} onChange={(event) => {
            setSelected(event.target.value);
            setReason("");
            setConfirmed(false);
            setActivationError("");
            setRevision((value) => value + 1);
          }}>
            <option value="">Select a later year</option>
            {laterYears.map((year) => <option value={year.id} key={year.id}>{year.name}</option>)}
          </select>
        </label>
        {target && <button type="button" className={secondary} disabled={saving} onClick={() => {
          setConfirmed(false);
          setRevision((value) => value + 1);
        }}>Refresh readiness</button>}
      </div>
      {target && !check && <p role="status" className="text-sm muted">Checking session readiness…</p>}
      {check?.error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{check.error}</p>}
      {readiness && target && (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {([
              ["Ready placements", readiness.destination_count],
              ["Missing placements", readiness.unplaced],
              ["Invalid placements", readiness.invalid_placements],
              ["Pending corrections", readiness.pending_corrections],
            ] as const).map(([label, count]) => (
              <div key={label} className="rounded-xl border border-[var(--border)] p-3">
                <dt className="muted">{label}</dt><dd className="mt-1 font-bold tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
          {!readiness.can_start_today && <p className="text-sm muted">Activation is available during the destination session ({target.start_date} to {target.end_date}, IST).</p>}
          {(readiness.unplaced > 0 || readiness.invalid_placements > 0) && <p className="text-sm muted">Resolve missing or invalid placements in Students before switching the school.</p>}
          {readiness.pending_corrections > 0 && <p className="text-sm muted">Resolve the previous session’s pending corrections in Attendance.</p>}
          {ready && (
            <form onSubmit={(event) => void activate(event)} className="max-w-xl space-y-3">
              <label className="block space-y-1 text-sm font-semibold">
                <span>Session activation reason</span>
                <textarea className="field min-h-20" required minLength={5} maxLength={300} disabled={saving}
                  value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
                <input type="checkbox" className="size-5 shrink-0" checked={confirmed} disabled={saving}
                  onChange={(event) => setConfirmed(event.target.checked)} />
                Switch the school’s active session to {target.name}
              </label>
              <button type="submit" disabled={saving || !confirmed || reason.trim().length < 5}
                className="min-h-11 rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {saving ? "Activating…" : "Confirm session activation"}
              </button>
            </form>
          )}
        </>
      )}
      {activationError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{activationError}</p>}
    </section>
  );
}
