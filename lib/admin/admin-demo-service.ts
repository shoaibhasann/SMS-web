export type AdminDemoModule =
  | "students"
  | "parents"
  | "teachers"
  | "academics"
  | "admissions"
  | "timetable"
  | "events"
  | "notifications"
  | "library"
  | "transport"
  | "inventory"
  | "hr-payroll"
  | "leave"
  | "profile"
  | "documents"
  | "reports"
  | "settings";

export type AdminDemoRecord = {
  id: string;
  [key: string]: string | number | boolean;
};

type AdminDemoStorage = Partial<Record<AdminDemoModule, AdminDemoRecord[]>>;
export const adminAdmissionsDemoMetrics = { availableSeats: 32 } as const;
export type AdminLibraryLoan = {
  id: string;
  student: string;
  admissionNo: string;
  book: string;
  issuedOn: string;
  dueDate: string;
  fine: number;
  status: "Issued" | "Returned" | "Overdue";
};
export type AdminTransportAllocation = {
  id: string;
  student: string;
  className: string;
  route: string;
  stop: string;
  status: "Active" | "Inactive";
};
export type AdminInventoryMovement = {
  id: string;
  item: string;
  quantityChange: number;
  reason: string;
  recordedOn: string;
};

const libraryLoanSeed: AdminLibraryLoan[] = [
  { id: "loan-demo-1", student: "Aarav Sharma", admissionNo: "KC-2026-001", book: "The Secret Garden", issuedOn: "2026-10-25", dueDate: "2026-11-08", fine: 0, status: "Issued" },
  { id: "loan-demo-2", student: "Anaya Verma", admissionNo: "KC-2026-002", book: "Atlas of the World", issuedOn: "2026-10-10", dueDate: "2026-10-24", fine: 20, status: "Overdue" },
];
const transportAllocationSeed: AdminTransportAllocation[] = [
  { id: "allocation-demo-1", student: "Aarav Sharma", className: "Class 6 A", route: "North Loop", stop: "Pitampura Market", status: "Active" },
  { id: "allocation-demo-2", student: "Anaya Verma", className: "Class 6 A", route: "South Loop", stop: "Green Park Metro", status: "Active" },
];

const demoSeed: AdminDemoStorage = {
  academics: [
    { id: "year-demo-1", recordType: "Academic Year", name: "2026–27", startDate: "2026-04-01", endDate: "2027-03-31", current: true, status: "Active" },
    { id: "year-demo-2", recordType: "Academic Year", name: "2025–26", startDate: "2025-04-01", endDate: "2026-03-31", current: false, status: "Inactive" },
    { id: "class-demo-1", recordType: "Class", name: "Class 6", sortOrder: 6, status: "Active" },
    { id: "class-demo-2", recordType: "Class", name: "Class 5", sortOrder: 5, status: "Active" },
    { id: "section-demo-1", recordType: "Section", name: "A", className: "Class 6", status: "Active" },
    { id: "section-demo-2", recordType: "Section", name: "B", className: "Class 5", status: "Active" },
    { id: "subject-demo-1", recordType: "Subject", name: "Science", code: "SCI", practical: true, status: "Active" },
    { id: "subject-demo-2", recordType: "Subject", name: "Mathematics", code: "MATH", practical: false, status: "Active" },
  ],
  students: [
    { id: "student-demo-1", admissionNo: "KC-2026-001", rollNo: "01", name: "Aarav Sharma", className: "Class 6", section: "A", academicYear: "2026–27", parent: "Neha Sharma", mobile: "98765 43210", status: "Active", dob: "2014-06-18", gender: "Male", email: "neha@example.test", address: "Green Park, Delhi" },
    { id: "student-demo-2", admissionNo: "KC-2026-002", rollNo: "02", name: "Anaya Verma", className: "Class 6", section: "A", academicYear: "2026–27", parent: "Rohan Verma", mobile: "98765 43211", status: "Active", dob: "2014-09-04", gender: "Female", email: "rohan@example.test", address: "South Extension, Delhi" },
    { id: "student-demo-3", admissionNo: "KC-2026-003", rollNo: "05", name: "Kabir Singh", className: "Class 5", section: "B", academicYear: "2026–27", parent: "Meera Singh", mobile: "98765 43212", status: "Inactive", dob: "2015-03-22", gender: "Male", email: "meera@example.test", address: "Lajpat Nagar, Delhi" },
  ],
  parents: [
    { id: "parent-demo-1", name: "Neha Sharma", relationship: "Mother", mobile: "98765 43210", email: "neha@example.test", address: "Green Park, Delhi", children: "Aarav Sharma", status: "Active" },
    { id: "parent-demo-2", name: "Rohan Verma", relationship: "Father", mobile: "98765 43211", email: "rohan@example.test", address: "South Extension, Delhi", children: "Anaya Verma", status: "Active" },
    { id: "parent-demo-3", name: "Meera Singh", relationship: "Mother", mobile: "98765 43212", email: "meera@example.test", address: "Lajpat Nagar, Delhi", children: "Kabir Singh", status: "Active" },
  ],
  teachers: [
    { id: "staff-demo-1", employeeId: "KC-T-014", name: "Priya Menon", email: "priya.menon@example.test", mobile: "98111 22334", designation: "Senior Teacher", department: "Science", qualification: "M.Sc. B.Ed.", joiningDate: "2022-04-04", status: "Active", assignments: "Class 6 A · Science; Class 7 A · Science", classTeacher: "Class 6 A", academicYear: "2026–27" },
    { id: "staff-demo-2", employeeId: "KC-T-021", name: "Arjun Rao", email: "arjun.rao@example.test", mobile: "98111 22335", designation: "Teacher", department: "Mathematics", qualification: "B.Sc. B.Ed.", joiningDate: "2024-06-12", status: "Active", assignments: "Class 5 B · Mathematics", classTeacher: "—", academicYear: "2026–27" },
  ],
  admissions: [
    { id: "admission-demo-1", applicationNo: "ADM-2026-018", studentName: "Ishaan Kapoor", parentName: "Kavita Kapoor", mobile: "98990 11001", className: "Class 3", section: "A", stage: "Application", status: "Pending", receivedOn: "2026-10-28", admissionFee: 2500 },
    { id: "admission-demo-2", applicationNo: "ADM-2026-017", studentName: "Sara Khan", parentName: "Imran Khan", mobile: "98990 11002", className: "Class 2", section: "B", stage: "Approved", status: "Approved", receivedOn: "2026-10-25", admissionFee: 2500 },
    { id: "admission-demo-3", applicationNo: "ENQ-2026-042", studentName: "Vihaan Das", parentName: "Anjali Das", mobile: "98990 11003", className: "Class 1", section: "A", stage: "Enquiry", status: "Enquiry", receivedOn: "2026-11-01", admissionFee: 0 },
  ],
  timetable: [
    { id: "period-demo-1", academicYear: "2026–27", className: "Class 6", section: "A", day: "Monday", period: "1", startTime: "08:30", endTime: "09:15", subject: "Mathematics", teacher: "Arjun Rao", room: "Room 12" },
    { id: "period-demo-2", academicYear: "2026–27", className: "Class 6", section: "A", day: "Monday", period: "2", startTime: "09:15", endTime: "10:00", subject: "Science", teacher: "Priya Menon", room: "Lab 1" },
    { id: "period-demo-3", academicYear: "2026–27", className: "Class 6", section: "A", day: "Tuesday", period: "1", startTime: "08:30", endTime: "09:15", subject: "English", teacher: "Ritu Joshi", room: "Room 12" },
    { id: "period-demo-4", academicYear: "2026–27", className: "Class 6", section: "A", day: "Wednesday", period: "1", startTime: "08:30", endTime: "09:15", subject: "Hindi", teacher: "Sanjay Bose", room: "Room 12" },
    { id: "period-demo-5", academicYear: "2026–27", className: "Class 6", section: "A", day: "Thursday", period: "1", startTime: "08:30", endTime: "09:15", subject: "Social Studies", teacher: "Nisha Rao", room: "Room 12" },
    { id: "period-demo-6", academicYear: "2026–27", className: "Class 6", section: "A", day: "Friday", period: "1", startTime: "08:30", endTime: "09:15", subject: "Science", teacher: "Priya Menon", room: "Lab 1" },
    { id: "period-demo-7", academicYear: "2026–27", className: "Class 6", section: "A", day: "Saturday", period: "1", startTime: "08:30", endTime: "09:15", subject: "Art", teacher: "Megha Das", room: "Art Room" },
  ],
  events: [
    { id: "event-demo-1", title: "Parent–Teacher Meeting", type: "PTM", date: "2026-11-07", startTime: "09:00", endTime: "12:00", location: "School Auditorium", audience: "Parents", status: "Scheduled", description: "Term progress discussions." },
    { id: "event-demo-2", title: "Children's Day Celebration", type: "School Event", date: "2026-11-14", startTime: "08:30", endTime: "13:00", location: "School Ground", audience: "Everyone", status: "Scheduled", description: "School-wide celebration and activities." },
  ],
  notifications: [
    { id: "notification-demo-1", title: "Fee due reminder", type: "Fee Due", audience: "Parents", date: "2026-11-02", status: "Sent", detail: "Monthly fee reminder for November." },
    { id: "notification-demo-2", title: "PTM scheduled", type: "Event", audience: "Parents", date: "2026-11-01", status: "Scheduled", detail: "Parent–Teacher Meeting on 7 November." },
  ],
  library: [
    { id: "book-demo-1", name: "The Secret Garden", isbn: "9780141321062", category: "Fiction", author: "Frances Hodgson Burnett", quantity: 8, available: 5, status: "Available" },
    { id: "book-demo-2", name: "Basic Science — Grade 6", isbn: "9788174506124", category: "Science", author: "School Edition", quantity: 12, available: 9, status: "Available" },
    { id: "book-demo-3", name: "Atlas of the World", isbn: "9780198310062", category: "Reference", author: "Oxford", quantity: 4, available: 0, status: "Issued" },
  ],
  transport: [
    { id: "vehicle-demo-1", vehicleNumber: "DL 1PC 4821", type: "School Bus", capacity: 40, driver: "Mahesh Kumar", status: "Active", route: "North Loop", stops: "Rohini · Pitampura · Model Town" },
    { id: "vehicle-demo-2", vehicleNumber: "DL 1PC 5174", type: "Van", capacity: 14, driver: "Suresh Yadav", status: "Active", route: "South Loop", stops: "Lajpat Nagar · Defence Colony · Green Park" },
  ],
  inventory: [
    { id: "item-demo-1", name: "Student desks", category: "Furniture", quantity: 80, condition: "Good", location: "Building A", purchaseDate: "2024-04-12", status: "In use" },
    { id: "item-demo-2", name: "Chromebook 14", category: "Computers", quantity: 24, condition: "Good", location: "Computer Lab", purchaseDate: "2025-06-20", status: "In use" },
    { id: "item-demo-3", name: "Microscope set", category: "Lab", quantity: 6, condition: "Needs repair", location: "Science Lab", purchaseDate: "2023-08-03", status: "Maintenance" },
  ],
  "hr-payroll": [
    { id: "employee-demo-1", employeeId: "KC-T-014", name: "Priya Menon", department: "Science", designation: "Senior Teacher", salary: 58000, month: "October 2026", gross: 58000, deductions: 2200, net: 55800, status: "Processed" },
    { id: "employee-demo-2", employeeId: "KC-S-008", name: "Rakesh Patel", department: "Operations", designation: "Transport Supervisor", salary: 42000, month: "October 2026", gross: 42000, deductions: 1500, net: 40500, status: "Pending" },
  ],
  leave: [
    { id: "leave-demo-1", employee: "Priya Menon", leaveType: "Casual Leave", from: "2026-11-10", to: "2026-11-11", days: 2, reason: "Personal commitment", status: "Pending" },
    { id: "leave-demo-2", employee: "Arjun Rao", leaveType: "Sick Leave", from: "2026-10-27", to: "2026-10-27", days: 1, reason: "Medical appointment", status: "Approved" },
  ],
  profile: [
    { id: "admin-profile-demo", name: "School Administrator", email: "admin@kidscorner.example", mobile: "011 4567 8900", designation: "School Administrator", address: "Kids Corner School, New Delhi", school: "Kids Corner School", status: "Active" },
  ],
  documents: [
    { id: "document-demo-1", name: "School Registration Certificate", category: "Registration", uploadedOn: "2026-04-01", fileName: "school-registration.pdf", status: "Available" },
    { id: "document-demo-2", name: "Child Protection Policy", category: "Policies", uploadedOn: "2026-06-14", fileName: "child-protection-policy.pdf", status: "Available" },
  ],
  reports: [
    { id: "report-demo-1", name: "Student Enrollment Summary", type: "Student", period: "Academic year 2026–27", generatedOn: "2026-11-01", status: "Ready" },
    { id: "report-demo-2", name: "Monthly Fee Collection", type: "Fee", period: "October 2026", generatedOn: "2026-11-01", status: "Ready" },
  ],
  settings: [
    { id: "settings-demo", schoolName: "Kids Corner School", phone: "011 4567 8900", email: "office@kidscorner.example", address: "New Delhi, India", currentYear: "2026–27", passingMarks: 35, lateFee: 50, dueDay: 10, workingDays: "Monday–Saturday", attendanceRule: "Daily register", notificationPreference: "Email and in-app" },
  ],
};

const storagePrefix = "kids-corner-admin-demo:";

function isRecordArray(value: unknown): value is AdminDemoRecord[] {
  return Array.isArray(value) && value.every((item) =>
    item !== null && typeof item === "object" && typeof item.id === "string",
  );
}

export const AdminDemoService = {
  load(module: AdminDemoModule): AdminDemoRecord[] {
    if (typeof window === "undefined") return structuredClone(demoSeed[module] ?? []);
    try {
      const saved = window.localStorage.getItem(`${storagePrefix}${module}`);
      if (!saved) return structuredClone(demoSeed[module] ?? []);
      const parsed: unknown = JSON.parse(saved);
      return isRecordArray(parsed) ? parsed : structuredClone(demoSeed[module] ?? []);
    } catch (error) {
      console.error(`Could not load local ${module} demo data`, error);
      return structuredClone(demoSeed[module] ?? []);
    }
  },
  save(module: AdminDemoModule, records: AdminDemoRecord[]) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(`${storagePrefix}${module}`, JSON.stringify(records));
  },
  reset(module: AdminDemoModule) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(`${storagePrefix}${module}`);
  },
  loadLibraryLoans(): AdminLibraryLoan[] {
    return loadLocalList("library-loans", libraryLoanSeed);
  },
  saveLibraryLoans(rows: AdminLibraryLoan[]) {
    saveLocalList("library-loans", rows);
  },
  loadTransportAllocations(): AdminTransportAllocation[] {
    return loadLocalList("transport-allocations", transportAllocationSeed);
  },
  saveTransportAllocations(rows: AdminTransportAllocation[]) {
    saveLocalList("transport-allocations", rows);
  },
  loadInventoryMovements(): AdminInventoryMovement[] {
    return loadLocalList("inventory-movements", []);
  },
  saveInventoryMovements(rows: AdminInventoryMovement[]) {
    saveLocalList("inventory-movements", rows);
  },
};

function loadLocalList<T>(key: string, seed: T[]): T[] {
  if (typeof window === "undefined") return structuredClone(seed);
  try {
    const saved = window.localStorage.getItem(`${storagePrefix}${key}`);
    return saved ? JSON.parse(saved) as T[] : structuredClone(seed);
  } catch (error) {
    console.error(`Could not load local ${key} demo data`, error);
    return structuredClone(seed);
  }
}

function saveLocalList<T>(key: string, rows: T[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(`${storagePrefix}${key}`, JSON.stringify(rows));
}
