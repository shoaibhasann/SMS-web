"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { familyNotificationsChangedEvent, familyNotificationsHref, loadFamilyNotificationUnreadCount, type FamilyNotificationRole } from "@/lib/notifications/family";

export function FamilyNotificationBell(props: { userId: string; role: FamilyNotificationRole; className: string }) {
  return <OwnFamilyNotificationBell key={`${props.userId}:${props.role}`} {...props} />;
}

function OwnFamilyNotificationBell({ userId, role, className }: { userId: string; role: FamilyNotificationRole; className: string }) {
  const [client] = useState(createClient);
  const [version, setVersion] = useState(0);
  const [count, setCount] = useState<{ version: number; value: number }>();
  const [sessionChanged, setSessionChanged] = useState(false);
  const request = useRef<AbortController | null>(null);
  const unread = count?.version === version ? count.value : undefined;

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { request.current?.abort(); setSessionChanged(true); }
    });
    return () => { request.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId]);
  useEffect(() => {
    if (sessionChanged) return;
    const controller = new AbortController(); request.current = controller;
    loadFamilyNotificationUnreadCount(client, role, userId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setCount({ version, value });
    }, () => { /* A failed count must not show a fabricated zero or old account's badge. */ });
    return () => { controller.abort(); if (request.current === controller) request.current = null; };
  }, [client, userId, role, version, sessionChanged]);
  useEffect(() => {
    if (sessionChanged) return;
    const refresh = () => setVersion((value) => value + 1);
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: unknown; role?: unknown }>).detail;
      if (detail?.userId === userId && detail.role === role) refresh();
    };
    window.addEventListener(familyNotificationsChangedEvent, changed);
    return () => window.removeEventListener(familyNotificationsChangedEvent, changed);
  }, [role, userId, sessionChanged]);

  if (sessionChanged) return null;
  return <Link href={familyNotificationsHref(role)} aria-label={`Open notifications${unread ? `, ${unread} unread` : ""}`}
    className={`relative inline-flex ${className}`}><Bell aria-hidden="true" size={19} strokeWidth={1.75} />
    {unread !== undefined && unread > 0 && <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-5 rounded-full border-2 border-[var(--surface)] bg-[var(--primary)] px-1 text-center text-[10px] font-bold leading-4 text-white dark:text-[#0b1020]">{unread > 99 ? "99+" : unread}</span>}
  </Link>;
}
