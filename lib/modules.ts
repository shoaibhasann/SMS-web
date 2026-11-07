import type { UiRole } from "@/lib/auth/roles";

export const modules = [
  { key: "students", label: "Students", icon: "Users", group: "People" },
  { key: "parents", label: "Parents", icon: "HeartHandshake", group: "People" },
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
  { key: "fees", label: "Fee", icon: "IndianRupee", group: "Finance" },
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
  parent: "Parent",
  reception: "Reception / Staff",
};

const roleModuleKeys: Record<UiRole, readonly string[]> = {
  admin: modules.map((module) => module.key),
  principal: modules.map((module) => module.key),
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
    "fees",
    "notices",
    "profile",
    "teacher-assignments",
  ],
  finance: ["students", "fees", "advance-credit", "invoices", "finance-reports", "notices", "reports"],
  reception: ["students", "notices", "events", "documents"],
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
    "fees",
    "advance-credit",
    "invoices",
    "notices",
    "events",
    "notifications",
    "profile",
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
    "fees",
    "advance-credit",
    "invoices",
    "notices",
    "events",
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
    .map((module) => family && module.key === "results" ? { ...module, label: "Published results" } : module);
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
