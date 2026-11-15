"use client";

import Link from "next/link";
import { ArrowLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadingState } from "@/components/ui/skeleton";
import { loadFamilyExamSchedule, loadFamilyExamSchedules, type FamilyNotificationRole } from "@/lib/notifications/family";
import { createClient } from "@/lib/supabase/client";

type Props = { assessmentId?: string; role: FamilyNotificationRole; userId: string };
type Exam = NonNullable<Awaited<ReturnType<typeof loadFamilyExamSchedule>>>;
type ExamPage = Awaited<ReturnType<typeof loadFamilyExamSchedules>>;
type Result = { exam: Exam | null } | { page: ExamPage } | { error: string };

const pageSize = 30;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = "This exam is no longer available.";
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
});
const button = "inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold disabled:opacity-50";

export function FamilyExamSchedule({ assessmentId, role, userId }: Props) {
  const id = assessmentId?.toLowerCase();
  return <Schedule key={`${role}:${userId}:${id ?? "upcoming"}`} assessmentId={id} role={role} userId={userId} />;
}

function Schedule({ assessmentId, role, userId }: Props) {
  const [client] = useState(createClient);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ attempt: number; offset: number; result: Result }>();
  const [sessionChanged, setSessionChanged] = useState(false);
  const exact = assessmentId !== undefined;
  const valid = !exact || uuid.test(assessmentId);
  const result = response?.attempt === attempt && response.offset === offset ? response.result : undefined;

  useEffect(() => {
    if (!valid || sessionChanged) return;
    const controller = new AbortController();
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      // Every Refresh re-subscribes, and auth-js replays INITIAL_SESSION (null while an expired token renews) to it.
      if (event === "INITIAL_SESSION") return;
      if (!controller.signal.aborted && session?.user.id !== userId) {
        controller.abort();
        setSessionChanged(true);
      }
    });

    async function load() {
      try {
        let result: Result;
        if (assessmentId !== undefined) {
          const exam = await loadFamilyExamSchedule(client, { id: assessmentId, userId, role }, controller.signal);
          result = { exam: exam?.id === assessmentId ? exam : null };
        } else {
          const page = await loadFamilyExamSchedules(client, { userId, role, offset }, controller.signal);
          result = { page };
        }
        if (!controller.signal.aborted) setResponse({ attempt, offset, result });
      } catch {
        if (!controller.signal.aborted) {
          setResponse({ attempt, offset, result: { error: "The exam schedule could not be loaded. Refresh to try again." } });
        }
      }
    }
    if (!controller.signal.aborted) void load();
    return () => {
      controller.abort();
      subscription.unsubscribe();
    };
  }, [assessmentId, attempt, client, offset, role, sessionChanged, userId, valid]);

  function refresh() {
    setOffset(0);
    setAttempt((value) => value + 1);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {exact && <Link href={`/modules/exams?view=${role === "parent" ? "guardian" : "student"}`}
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--primary)] hover:underline">
            <ArrowLeft size={16} aria-hidden="true" /> Back to exam schedule
          </Link>}
          <h1 className="text-3xl font-black">Exam schedule</h1>
          <p className="mt-2 text-sm muted">{exact ? "Published exam details." : "Upcoming exams shared by your school."}</p>
        </div>
        {valid && !sessionChanged && (
          <button type="button" aria-label="Refresh exam schedule" disabled={!result} onClick={refresh} className={button}>
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        )}
      </header>
      <section className="card min-w-0 overflow-hidden" aria-label={exact ? "Requested exam" : "Upcoming exams"}
        aria-busy={valid && !sessionChanged && !result}>
        {sessionChanged ? <p role="alert" className="p-5 text-sm muted">Your sign-in changed. Reopen the exam schedule.</p>
          : !valid ? <p className="p-5 text-sm muted">{unavailable}</p>
            : !result ? <LoadingState variant={exact ? "form" : "list"} label="Loading exam schedule…" className="p-5" />
              : "error" in result ? <div className="space-y-3 p-5"><p role="alert" className="text-sm text-danger">{result.error}</p>
                <button type="button" className="btn btn-secondary" onClick={refresh}>Try again</button></div>
                : "exam" in result ? result.exam ? <ExamDetail exam={result.exam} /> : <p className="p-5 text-sm muted">{unavailable}</p>
                  : <ExamList role={role} page={result.page} offset={offset} onPage={setOffset} />}
      </section>
    </div>
  );
}

function ExamMetadata({ exam }: { exam: Exam }) {
  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm muted">
      <time dateTime={exam.assessment_date}>{dateFormat.format(new Date(`${exam.assessment_date}T00:00:00Z`))}</time>
      <span>{exam.subject_name}</span>
      <span>{exam.class_name}{exam.section_name ? ` / ${exam.section_name}` : ""}</span>
    </div>
  );
}

function ExamDetail({ exam }: { exam: Exam }) {
  return (
    <article className="min-w-0 break-words p-5">
      <h2 className="text-xl font-bold">{exam.name}</h2>
      <ExamMetadata exam={exam} />
      {exam.description && <p className="mt-4 whitespace-pre-wrap text-sm">{exam.description}</p>}
    </article>
  );
}

function ExamList({ role, page, offset, onPage }: {
  role: FamilyNotificationRole; page: ExamPage; offset: number; onPage: (offset: number) => void;
}) {
  const { rows, total_count } = page;
  const next = offset + pageSize < total_count;
  return (
    <>
      {rows.length ? <ul className="divide-y divide-[var(--border)]">
        {rows.map((exam) => (
          <li key={exam.id}>
            <Link href={`/modules/exams?${role === "parent" ? "view=guardian&" : ""}assessment=${encodeURIComponent(exam.id)}`}
              className="flex min-h-11 items-center justify-between gap-3 p-5 hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[var(--primary)]">
              <div className="min-w-0 break-words">
                <h2 className="font-bold">{exam.name}</h2>
                <ExamMetadata exam={exam} />
              </div>
              <ChevronRight className="shrink-0 muted" size={18} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul> : <p className="p-5 text-sm muted">{offset ? "No upcoming exams on this page." : "No upcoming exams are scheduled."}</p>}
      {(offset > 0 || next) && <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] p-4">
        <p className="text-sm muted">{rows.length ? `Showing ${offset + 1}–${offset + rows.length} of ${total_count}` : `${total_count} upcoming exams`}</p>
        <div className="flex gap-2">
          <button type="button" className={button} aria-label="Previous exams" disabled={offset === 0} onClick={() => onPage(offset - pageSize)}>Previous</button>
          <button type="button" className={button} aria-label="Next exams" disabled={!next} onClick={() => onPage(offset + pageSize)}>Next</button>
        </div>
      </footer>}
    </>
  );
}
