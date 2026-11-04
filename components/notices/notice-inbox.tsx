"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Notice = {
  id: string;
  title: string;
  content: string;
  published_at: string;
};

type NoticeResult = { notices: Notice[] } | { error: string };

const publishDate = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
});

export function NoticeInbox() {
  const [supabase] = useState(createClient);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<NoticeResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const now = new Date().toISOString();
    async function load() {
      try {
        const { data, error } = await supabase
          .from("notices")
          .select("id,title,content,published_at")
          .lte("published_at", now)
          .or(`expires_at.is.null,expires_at.gt.${now}`)
          .order("published_at", { ascending: false })
          .order("id")
          .limit(50)
          .abortSignal(controller.signal)
          .returns<Notice[]>();
        if (error) throw error;
        if (!controller.signal.aborted) setResult({ notices: data ?? [] });
      } catch {
        if (!controller.signal.aborted) {
          setResult({ error: "Notices could not be loaded. Please try again." });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [supabase, version]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Notices &amp; Circulars</h1>
          <p className="mt-2 text-sm muted">Recent notices for your school and audience.</p>
        </div>
        <button
          type="button"
          disabled={!result}
          onClick={() => { setResult(null); setVersion((value) => value + 1); }}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-50"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </header>
      <section className="card overflow-hidden" aria-label="Recent school notices">
        {!result ? <p role="status" className="p-5 text-sm muted">Loading notices…</p>
          : "error" in result ? <p role="alert" className="p-5 text-sm text-red-700 dark:text-red-300">{result.error}</p>
          : result.notices.length === 0 ? <p className="p-5 text-sm muted">No notices are available right now.</p>
          : <div className="divide-y divide-[var(--border)]">
            {result.notices.map((notice) => (
              <article key={notice.id} className="space-y-2 break-words p-5">
                <h2 className="font-bold">{notice.title}</h2>
                <time className="block text-xs muted" dateTime={notice.published_at}>
                  {publishDate.format(new Date(notice.published_at))}
                </time>
                <p className="whitespace-pre-wrap text-sm">{notice.content}</p>
              </article>
            ))}
          </div>}
      </section>
    </div>
  );
}
