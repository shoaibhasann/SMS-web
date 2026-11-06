"use client";

import { FamilyNotificationInbox } from "./family-notification-inbox";

export function GuardianAttendanceAlerts({ userId, summary = false }: { userId: string; summary?: boolean }) {
  return <FamilyNotificationInbox userId={userId} role="parent" summary={summary} />;
}
