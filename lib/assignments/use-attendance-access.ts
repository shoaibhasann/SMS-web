"use client";

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEffectiveAttendanceAssignments, type EffectiveAttendanceAssignment } from "./attendance-coverage";

function scopeSignature(rows: EffectiveAttendanceAssignment[]) {
  return JSON.stringify(rows.map((row) => [row.id, row.teacher_id, row.academic_year_id, row.class_id,
    row.section_id, row.coverage_id, row.starts_on, row.ends_on]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** True when the selected register's exact scope (id, class, section, coverage window) is still granted. */
export function hasAttendanceScope(rows: EffectiveAttendanceAssignment[], selected: EffectiveAttendanceAssignment) {
  const wanted = scopeSignature([selected]);
  return rows.some((row) => scopeSignature([row]) === wanted);
}

/**
 * Revalidate authorization without disturbing a clean or dirty register while access is unchanged.
 * While `locked` (unsaved, saving or loading edits), a failed check keeps the register and returns
 * `true` until a later check succeeds; only a returned list without the selected scope revokes it.
 */
export function useAttendanceAccessRevalidation({ client, enabled, assignments, locked, onChanged, onUnavailable }: {
  client: SupabaseClient;
  enabled: boolean;
  assignments: EffectiveAttendanceAssignment[];
  locked: boolean;
  onChanged: (current: EffectiveAttendanceAssignment[]) => void;
  onUnavailable: () => void;
}) {
  const callbacks = useRef({ onChanged, onUnavailable, locked });
  const [unverified, setUnverified] = useState(false);
  const signature = scopeSignature(assignments);
  useEffect(() => { callbacks.current = { onChanged, onUnavailable, locked }; }, [onChanged, onUnavailable, locked]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const current = await loadEffectiveAttendanceAssignments(client, controller.signal);
        if (controller.signal.aborted) return;
        setUnverified(false);
        if (scopeSignature(current) !== signature) callbacks.current.onChanged(current);
      } catch {
        if (controller.signal.aborted) return;
        if (callbacks.current.locked) setUnverified(true);
        else { setUnverified(false); callbacks.current.onUnavailable(); }
      } finally { pending = false; }
    };
    const refresh = () => { void check(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      controller.abort();
      setUnverified(false);
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [client, enabled, signature]);
  return enabled && unverified;
}
