"use client";

import { useEffect, useRef } from "react";
import { getCurrentTeacherAssignments, type TeachingAssignment } from "./academic";
import { academicAssignmentSignature } from "./academic-permissions";

/** Keep authoring controls aligned with live grants without clearing unchanged drafts. */
export function useAcademicAssignmentRevalidation({ enabled, assignments, onChanged, onUnavailable }: {
  enabled: boolean;
  assignments: TeachingAssignment[];
  onChanged: (assignments: TeachingAssignment[]) => void;
  onUnavailable: () => void;
}) {
  const callbacks = useRef({ onChanged, onUnavailable });
  const signature = academicAssignmentSignature(assignments);
  useEffect(() => { callbacks.current = { onChanged, onUnavailable }; }, [onChanged, onUnavailable]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const next = await getCurrentTeacherAssignments({ currentYearOnly: true });
        if (active && academicAssignmentSignature(next) !== signature) callbacks.current.onChanged(next);
      } catch {
        if (active) callbacks.current.onUnavailable();
      } finally { pending = false; }
    };
    const refresh = () => { void check(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, signature]);
}
