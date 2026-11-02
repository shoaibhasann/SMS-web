export type UiRole = "admin" | "principal" | "teacher" | "finance" | "student" | "parent" | "reception";

export function toUiRole(role: string): UiRole | null {
  if (role === "super_admin" || role === "school_admin") return "admin";
  if (role === "accountant" || role === "finance") return "finance";
  if (role === "reception_staff" || role === "reception") return "reception";
  if (role === "principal") return "principal";
  if (role === "teacher") return "teacher";
  if (role === "student") return "student";
  if (role === "parent") return "parent";
  return null;
}

export function resolveUiRole(roleRows: readonly { role: string }[]): UiRole | null {
  const roles = roleRows
    .map((row) => toUiRole(row.role))
    .filter((role): role is UiRole => role !== null);

  return roles.find((role) => role === "admin")
    ?? roles.find((role) => role === "principal")
    ?? roles.find((role) => role === "teacher")
    ?? roles[0]
    ?? null;
}

export function roleLabel(role: UiRole) {
  return {
    admin: "School Admin",
    principal: "Principal",
    teacher: "Teacher",
    finance: "Finance",
    student: "Student",
    parent: "Parent",
    reception: "Reception / Staff",
  }[role];
}
