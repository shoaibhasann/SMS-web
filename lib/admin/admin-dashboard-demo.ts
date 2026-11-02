export const adminDashboardDemo = {
  label: "Demo preview",
  today: {
    pendingHomework: 12,
    absentStudents: 18,
    teachersActive: 8,
    upcomingExams: 2,
  },
  alerts: [
    { title: "Low Attendance", message: "2 classes are below the attendance target." },
    { title: "Pending Fees", message: "Several fee balances are awaiting collection." },
    { title: "Important Notices", message: "2 school notices are active." },
    { title: "Teacher Activity Issues", message: "No activity issues reported." },
  ],
  recentHomework: [
    { id: "homework-preview-1", title: "Fractions practice", className: "Class 6 A", dueDate: "2026-11-04" },
    { id: "homework-preview-2", title: "Plant life worksheet", className: "Class 5 B", dueDate: "2026-11-05" },
  ],
} as const;

export const adminFinanceReportDemo = {
  classDues: [
    { className: "Class 6", pendingStudents: 18, balance: 24500 },
    { className: "Class 5", pendingStudents: 12, balance: 16800 },
    { className: "Class 4", pendingStudents: 9, balance: 11250 },
  ],
} as const;
