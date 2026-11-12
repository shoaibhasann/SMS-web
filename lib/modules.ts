import { resolveUiRole, toUiRole, type UiRole } from "@/lib/auth/roles";

export const modules = [
  { key: "students", label: "Students", icon: "Users", group: "People" },
  { key: "parents", label: "Guardians", icon: "HeartHandshake", group: "People" },
  { key: "guardian-invitations", label: "Guardian invitations", icon: "MailPlus", group: "People" },
  { key: "teachers", label: "Teachers & Staff", icon: "GraduationCap", group: "People" },
  { key: "admissions", label: "Admissions", icon: "ClipboardPlus", group: "People" },
  { key: "class-logs", label: "Academic Log", icon: "NotebookPen", group: "Academics" },
  { key: "classwork", label: "Classwork", icon: "BookOpen", group: "Academics" },
  { key: "homework", label: "Homework", icon: "FilePenLine", group: "Academics" },
  { key: "assignments", label: "Assignments", icon: "ClipboardList", group: "Academics" },
  { key: "projects", label: "Projects", icon: "FolderKanban", group: "Academics" },
  { key: "study-material", label: "Study Material", icon: "LibraryBig", group: "Academics" },
  { key: "missed-activities", label: "What You Missed", icon: "CircleAlert", group: "Academics" },
  { key: "attendance", label: "Attendance", icon: "CalendarCheck", group: "Academics" },
  { key: "student-leave", label: "Leave requests", icon: "CalendarOff", group: "Academics" },
  { key: "academics", label: "Academics & Subjects", icon: "BookOpen", group: "Academics" },
  { key: "teacher-assignments", label: "Teaching Assignments", icon: "GraduationCap", group: "Academics" },
  { key: "exams", label: "Exam / Marks", icon: "PencilRuler", group: "Assessment" },
  { key: "results", label: "Result Report", icon: "ChartNoAxesCombined", group: "Assessment" },
  { key: "published-results", label: "Result publication", icon: "BadgeCheck", group: "Assessment" },
  { key: "timetable", label: "Timetable", icon: "CalendarClock", group: "Assessment" },
  { key: "fees", label: "Fees", icon: "IndianRupee", group: "Finance" },
  { key: "advance-credit", label: "Advance credit", icon: "WalletCards", group: "Finance" },
  { key: "invoices", label: "Invoices & Receipts", icon: "ReceiptText", group: "Finance" },
  { key: "finance-reports", label: "Finance Reports", icon: "Banknote", group: "Finance" },
  { key: "notices", label: "Notices & Circulars", icon: "Megaphone", group: "Communication" },
  { key: "events", label: "Events & Calendar", icon: "PartyPopper", group: "Communication" },
  { key: "notifications", label: "Notifications", icon: "BellRing", group: "Communication" },
  { key: "library", label: "Library", icon: "Library", group: "Operations" },
  { key: "transport", label: "Transport", icon: "BusFront", group: "Operations" },
  { key: "inventory", label: "Inventory", icon: "Boxes", group: "Operations" },
  { key: "hr-payroll", label: "HR & Payroll", icon: "BriefcaseBusiness", group: "Operations" },
  { key: "leave", label: "Leave Management", icon: "CalendarOff", group: "Operations" },
  { key: "profile", label: "Profile", icon: "UserRound", group: "System" },
  { key: "documents", label: "Documents", icon: "Files", group: "System" },
  { key: "reports", label: "Reports & Analytics", icon: "BarChart3", group: "System" },
  { key: "audit-logs", label: "Audit Logs", icon: "ShieldCheck", group: "System" },
  { key: "settings", label: "Settings", icon: "Settings", group: "System" },
] as const;

export const roleLabels: Record<UiRole, string> = {
  admin: "School Admin",
  principal: "Principal",
  teacher: "Teacher",
  finance: "Finance",
  student: "Student",
  parent: "Guardian",
  reception: "Reception / Staff",
};

// Principal has no workspace yet for these keys; listing them would open a dead-end page.
const principalUnbuilt = ["exams", "results", "events", "library", "transport", "inventory", "hr-payroll", "leave", "profile", "documents"];

// Each role lists only modules that route to a real workspace for that role.
const roleModuleKeys: Record<UiRole, readonly string[]> = {
  admin: modules.map((module) => module.key),
  principal: modules.map((module) => module.key).filter((key) => !principalUnbuilt.includes(key)),
  teacher: [
    "class-logs",
    "classwork",
    "homework",
    "study-material",
    "exams",
    "results",
    "published-results",
    "timetable",
    "attendance",
    "notices",
    "profile",
    "teacher-assignments",
  ],
  finance: ["fees", "advance-credit", "invoices", "finance-reports", "notices"],
  reception: ["notices"],
  student: [
    "attendance",
    "student-leave",
    "class-logs",
    "classwork",
    "homework",
    "assignments",
    "projects",
    "study-material",
    "missed-activities",
    "exams",
    "results",
    "published-results",
    "timetable",
    "advance-credit",
    "invoices",
    "notices",
    "notifications",
  ],
  parent: [
    "attendance",
    "student-leave",
    "class-logs",
    "classwork",
    "homework",
    "assignments",
    "projects",
    "study-material",
    "missed-activities",
    "exams",
    "results",
    "published-results",
    "timetable",
    "advance-credit",
    "invoices",
    "notices",
    "notifications",
    "profile",
  ],
};

export function canAccessModule(role: UiRole, moduleKey: string) {
  if (moduleKey === "teacher-assignments") return role === "teacher" || role === "admin" || role === "principal";
  if (moduleKey === "result-report") moduleKey = "results";
  return roleModuleKeys[role].includes(moduleKey);
}

export function getVisibleModules(role: UiRole) {
  const family = role === "parent" || role === "student";
  return modules.filter((module) => roleModuleKeys[role].includes(module.key) && !(family && module.key === "published-results"))
    .map((module) => {
      if (family && module.key === "results") return { ...module, label: "Published results" };
      if (family && module.key === "exams") return { ...module, label: "Exam schedule" };
      return module;
    });
}

export function getAdminNavigationModules() {
  const adminOrder = [
    "students", "parents", "teachers", "admissions", "guardian-invitations",
    "attendance", "student-leave", "academics", "teacher-assignments", "timetable",
    "exams", "results", "published-results",
    "fees", "advance-credit", "invoices", "finance-reports",
    "notices", "events", "notifications",
    "library", "transport", "inventory", "hr-payroll", "leave",
    "profile", "documents", "reports", "audit-logs", "settings",
  ];
  return adminOrder
    .map((key) => modules.find((module) => module.key === key))
    .filter((module): module is (typeof modules)[number] => Boolean(module))
    .map((module) => module.key === "timetable" ? { ...module, group: "Academics" } : module);
}

export function getTeacherNavigationModules() {
  const teacherOrder = roleModuleKeys.teacher;
  return teacherOrder
    .map((key) => modules.find((module) => module.key === key))
    .filter((module): module is (typeof modules)[number] => Boolean(module));
}

const staffRoles: readonly UiRole[] = ["finance", "reception", "teacher"];
const unionRoles: readonly UiRole[] = ["principal", ...staffRoles];

/** Role whose workspace opens a module: the union of the account's same-school staff roles, office roles first. */
export function resolveModuleRole(rows: readonly { role: string; school_id?: string | null }[], schoolId: string | null, moduleKey: string) {
  const primary = resolveUiRole(rows);
  if (!primary || !unionRoles.includes(primary)) return primary;
  // A principal who also teaches keeps the principal workspace and falls through to the teacher one only for modules principal lacks.
  if (primary === "principal" && canAccessModule(primary, moduleKey)) return primary;
  const held = new Set(rows.filter((row) => row.school_id === schoolId).map((row) => toUiRole(row.role)));
  return staffRoles.find((role) => held.has(role) && canAccessModule(role, moduleKey)) ?? primary;
}

/** Navigation for `role`, plus the modules of the account's other same-school principal/staff roles. */
export function getNavigationModules(role: UiRole, schoolRoles: readonly (UiRole | null)[] = []) {
  const base = role === "teacher" ? getTeacherNavigationModules() : role === "admin" ? getAdminNavigationModules() : getVisibleModules(role);
  // Admin already lists every module; families never gain staff modules.
  if (!unionRoles.includes(role) || schoolRoles.includes("admin")) return base;
  const keys = new Set(base.map((module) => module.key));
  const extra = unionRoles.filter((other) => other !== role && schoolRoles.includes(other))
    .flatMap((other) => getVisibleModules(other))
    .filter((module) => {
      if (keys.has(module.key)) return false;
      keys.add(module.key);
      return true;
    });
  return [...base, ...extra];
}
