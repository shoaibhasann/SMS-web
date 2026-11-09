"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { StudentHomeworkSubmission } from "@/components/academic/homework-submission";
import { LoadingState } from "@/components/ui/skeleton";
import { familyNotificationsHref, loadFamilyHomework, type FamilyNotificationRole } from "@/lib/notifications/family";
import { createClient } from "@/lib/supabase/client";

type Props = { activityId: string; role: FamilyNotificationRole; userId: string };
type Homework = NonNullable<Awaited<ReturnType<typeof loadFamilyHomework>>>;
type Result = { homework: Homework | null } | { error: string };

const activityIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = "This homework is no longer available.";
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
});

export function FamilyHomeworkDetail({ activityId, role, userId }: Props) {
  const id = activityId.toLowerCase();
  return <HomeworkDetail key={`${role}:${userId}:${id}`} activityId={id} role={role} userId={userId} />;
}

function HomeworkDetail({ activityId, role, userId }: Props) {
  const [client] = useState(createClient);
  const [response, setResponse] = useState<{ attempt: number; result: Result }>();
  const [attempt, setAttempt] = useState(0);
  const [sessionChanged, setSessionChanged] = useState(false);
  const validId = activityIdPattern.test(activityId);
  const result = response?.result;
  const refreshing = response?.attempt !== attempt;

  useEffect(() => {
    if (!validId || sessionChanged) return;
    const controller = new AbortController();
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (!controller.signal.aborted && session?.user.id !== userId) {
        controller.abort();
        setSessionChanged(true);
      }
    });
    const refreshOnFocus = () => {
      if (document.visibilityState !== "hidden") setAttempt((value) => value + 1);
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);

    async function load() {
      try {
        const homework = await loadFamilyHomework(client, { id: activityId, userId, role }, controller.signal);
        if (!controller.signal.aborted) {
          setResponse({ attempt, result: { homework: homework?.id === activityId ? homework : null } });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResponse({ attempt, result: { error: "Homework could not be loaded. Refresh to try again." } });
        }
      }
    }
    if (!controller.signal.aborted) void load();
    return () => {
      controller.abort();
      subscription.unsubscribe();
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [activityId, attempt, client, role, sessionChanged, userId, validId]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={familyNotificationsHref(role)}
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--primary)] hover:underline">
            <ArrowLeft size={16} aria-hidden="true" /> Back to notifications
          </Link>
          <h1 className="text-3xl font-black">Homework</h1>
          <p className="mt-2 text-sm muted">Assignment from your notifications.</p>
        </div>
        {validId && !sessionChanged && (
          <button type="button" aria-label="Refresh homework" disabled={refreshing}
            onClick={() => setAttempt((value) => value + 1)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold disabled:opacity-50">
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        )}
      </header>
      <section className="card min-w-0 overflow-hidden" aria-label="Requested homework" aria-busy={validId && !sessionChanged && refreshing}>
        {sessionChanged ? <p role="alert" className="p-5 text-sm muted">Your sign-in changed. Reopen this homework from Notifications.</p>
          : !validId ? <p className="p-5 text-sm muted">{unavailable}</p>
            : !result ? <LoadingState variant="form" label="Loading homework…" className="p-5" />
              : "error" in result ? <p role="alert" className="p-5 text-sm text-red-700 dark:text-red-300">{result.error}</p>
                : result.homework ? <HomeworkArticle homework={result.homework} role={role} userId={userId} />
                  : <p className="p-5 text-sm muted">{unavailable}</p>}
      </section>
    </div>
  );
}

function HomeworkArticle({ homework, role, userId }: { homework: Homework; role: FamilyNotificationRole; userId: string }) {
  const { academic_year_id, class_id, school_id, section_id, student_id, subject_id } = homework;
  return (
    <article className="min-w-0 space-y-4 break-words p-5">
      <h2 className="text-xl font-bold">{homework.title}</h2>
      {homework.description && <p className="whitespace-pre-wrap text-sm">{homework.description}</p>}
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div><dt className="font-semibold">Added</dt><dd className="muted">
          <time dateTime={homework.created_at}>{dateFormat.format(new Date(homework.created_at))}</time>
        </dd></div>
        {homework.due_date && <div><dt className="font-semibold">Due</dt><dd className="muted">
          <time dateTime={homework.due_date}>{dateFormat.format(new Date(`${homework.due_date}T00:00:00Z`))}</time>
        </dd></div>}
      </dl>
      {role === "student" && (
        school_id && academic_year_id && class_id && section_id && subject_id && student_id
          ? <StudentHomeworkSubmission key={`${userId}:${student_id}:${homework.id}`} userId={userId}
              maxMarks={homework.max_marks} scope={{
                schoolId: school_id, academicYearId: academic_year_id, classId: class_id,
                sectionId: section_id, subjectId: subject_id, activityId: homework.id, studentId: student_id,
              }} />
          : <p className="text-sm muted">Submissions are unavailable for this homework.</p>
      )}
    </article>
  );
}
