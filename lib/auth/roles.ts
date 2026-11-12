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

// Fixed priority so the landing role never depends on user_roles row order.
const uiRolePriority: readonly UiRole[] = ["admin", "principal", "teacher", "finance", "reception", "student", "parent"];

export function resolveUiRole(roleRows: readonly { role: string }[]): UiRole | null {
  const roles = new Set(roleRows.map((row) => toUiRole(row.role)));
  return uiRolePriority.find((role) => roles.has(role)) ?? null;
}

export function roleLabel(role: UiRole) {
  return {
    admin: "School Admin",
    principal: "Principal",
    teacher: "Teacher",
    finance: "Finance",
    student: "Student",
    parent: "Guardian",
    reception: "Reception / Staff",
  }[role];
}
