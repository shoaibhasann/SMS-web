import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { attendanceLabels, type AttendanceStatus } from "@/lib/attendance/types";

/** One pupil's status choices in the register (tap buttons, one radio group per pupil). */
export function attendanceGroup(name: string) {
  return screen.getByRole("radiogroup", { name: `Attendance for ${name}` });
}

export function findAttendanceGroup(name: string) {
  return screen.findByRole("radiogroup", { name: `Attendance for ${name}` });
}

function statusRadios(name: string) {
  return within(attendanceGroup(name)).getAllByRole("radio") as HTMLInputElement[];
}

/** The pupil's shown status, or "" while unmarked. */
export function statusOf(name: string) {
  return statusRadios(name).find((radio) => radio.checked)?.value ?? "";
}

/** True when none of the pupil's statuses can be chosen. */
export function rowLocked(name: string) {
  return statusRadios(name).every((radio) => radio.disabled);
}

export function statusChoice(name: string, status: AttendanceStatus) {
  return within(attendanceGroup(name)).queryByRole("radio", { name: attendanceLabels[status] });
}

export async function chooseStatus(user: UserEvent, name: string, status: AttendanceStatus) {
  const choice = statusChoice(name, status);
  if (!choice) throw new Error(`${attendanceLabels[status]} is not offered for ${name}.`);
  await user.click(choice);
}
