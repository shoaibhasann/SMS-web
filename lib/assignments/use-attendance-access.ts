"use client";

import { useEffect, useRef } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEffectiveAttendanceAssignments, type EffectiveAttendanceAssignment } from "./attendance-coverage";

function scopeSignature(rows: EffectiveAttendanceAssignment[]) {
  return JSON.stringify(rows.map((row) => [row.id, row.teacher_id, row.academic_year_id, row.class_id,
    row.section_id, row.coverage_id, row.starts_on, row.ends_on]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** Revalidate authorization without disturbing a clean or dirty register while access is unchanged. */
export function useAttendanceAccessRevalidation({ client, enabled, assignments, onChanged, onUnavailable }: {
  client: SupabaseClient;
  enabled: boolean;
  assignments: EffectiveAttendanceAssignment[];
  onChanged: () => void;
  onUnavailable: () => void;
}) {
  const callbacks = useRef({ onChanged, onUnavailable });
  const signature = scopeSignature(assignments);
  useEffect(() => { callbacks.current = { onChanged, onUnavailable }; }, [onChanged, onUnavailable]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const current = await loadEffectiveAttendanceAssignments(client, controller.signal);
        if (!controller.signal.aborted && scopeSignature(current) !== signature) callbacks.current.onChanged();
      } catch {
        if (!controller.signal.aborted) callbacks.current.onUnavailable();
      } finally { pending = false; }
    };
    const refresh = () => { void check(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [client, enabled, signature]);
}
