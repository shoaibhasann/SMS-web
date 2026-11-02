"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useParams } from "next/navigation";
import { AcademicWorkspace } from "@/components/academic/academic-workspace";
import { AppShell } from "@/components/layout/app-shell";
import { canAccessModule } from "@/lib/modules";
import { resolveUiRole, type UiRole } from "@/lib/auth/roles";
import { TeacherModuleView } from "@/components/teacher/teacher-views";
import { TeacherAcademicActivityWorkspace } from "@/components/academic/teacher-activity-workspace";
import { AdminModulePlaceholder } from "@/components/admin/admin-module-placeholder";
import { AdminAssessmentWorkspace } from "@/components/admin/admin-assessment-workspace";
import { AdminNoticesWorkspace } from "@/components/admin/admin-notices-workspace";
import { AdminFinanceWorkspace } from "@/components/admin/admin-finance-workspace";
import { AdminAcademicSetupWorkspace } from "@/components/admin/admin-academic-setup-workspace";
import { AdminAttendanceWorkspace } from "@/components/admin/admin-attendance-workspace";
import { AdminDemoWorkspace } from "@/components/admin/admin-demo-workspace";
import type { AdminDemoModule } from "@/lib/admin/admin-demo-service";

const supabase = createClient();

type AttendanceStatus =
  | "present"
  | "absent"
  | "late"
  | "half_day"
  | "leave"
  | "holiday";

type StudentRow = {
  id: string;
  first_name: string;
  middle_name?: string | null;
  last_name?: string | null;
  admission_no: string;
  roll_no?: string | null;
};

type AttendanceMap = Record<string, AttendanceStatus>;

function formatStudentName(student: StudentRow) {
  return [student.first_name, student.middle_name, student.last_name]
    .filter(Boolean)
    .join(" ");
}

function todayISO() {
  const d = new Date();

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatDateDisplay(value: string) {
  if (!value) return "";

  const [year, month, day] = value.split("-");

  if (!year || !month || !day) return value;

  return `${day}-${month}-${year}`;
}

function statusLabel(status: AttendanceStatus) {
  switch (status) {
    case "present":
      return "Present";
    case "absent":
      return "Absent";
    case "late":
      return "Late";
    case "half_day":
      return "Half Day";
    case "leave":
      return "Leave";
    case "holiday":
      return "Holiday";
    default:
      return status;
  }
}

function statusButtonClass(
  current: AttendanceStatus | undefined,
  status: AttendanceStatus
) {
  const active = current === status;

  if (active) {
    return "border-blue-500 bg-blue-600 text-white";
  }

  return "border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800";
}

export default function ModulePage() {
  const params = useParams();
  const moduleName = String(params?.module || "");
  const [access, setAccess] = useState<{
    moduleName: string;
    role: UiRole | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const loadRole = async () => {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError) throw authError;
        if (!user) {
          if (active) setAccess({ moduleName, role: null, error: "Please sign in to access this module." });
          return;
        }

        const { data: roleRows, error: roleError } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id);
        if (roleError) throw roleError;
        const role = resolveUiRole(roleRows ?? []);
        if (active) setAccess({
          moduleName,
          role,
          error: role ? null : "No recognized role is assigned to this login.",
        });
      } catch (error) {
        if (active) setAccess({
          moduleName,
          role: null,
          error: error instanceof Error ? error.message : "Your access could not be verified.",
        });
      }
    };

    void loadRole();
    return () => {
      active = false;
    };
  }, [moduleName]);

  if (!access || access.moduleName !== moduleName) {
    return <main className="min-h-screen bg-[var(--bg)] p-6 text-sm muted">Checking module access...</main>;
  }
  if (access.error || !access.role) {
    return (
      <main className="min-h-screen bg-[var(--bg)] p-6">
        <div role="alert" className="mx-auto max-w-2xl rounded-2xl border border-red-500/30 bg-[var(--surface)] p-6 text-sm text-red-600">
          {access.error ?? "Your role does not allow access to this module."}
        </div>
      </main>
    );
  }
  if (!canAccessModule(access.role, moduleName)) {
    return (
      <AppShell role={access.role}>
        <div role="alert" className="rounded-2xl border border-red-500/30 bg-[var(--surface)] p-6 text-sm text-red-600">
          Your role does not allow access to this module.
        </div>
      </AppShell>
    );
  }

  if (moduleName === "attendance") {
    if (access.role === "admin") {
      return <AppShell role="admin"><AdminAttendanceWorkspace /></AppShell>;
    }
    return <AttendanceRegister />;
  }

  if ((moduleName === "classwork" || moduleName === "homework") && access.role === "teacher") {
    return (
      <AppShell role="teacher">
        <TeacherAcademicActivityWorkspace module={moduleName} />
      </AppShell>
    );
  }

  if (moduleName === "academics" && access.role === "admin") {
    return <AppShell role="admin"><AdminAcademicSetupWorkspace /></AppShell>;
  }

  if (access.role === "admin" && moduleName === "exams") {
    return <AppShell role="admin"><AdminAssessmentWorkspace mode="exams" /></AppShell>;
  }

  if (access.role === "admin" && (moduleName === "results" || moduleName === "result-report")) {
    return <AppShell role="admin"><AdminAssessmentWorkspace mode="results" /></AppShell>;
  }

  if (access.role === "admin" && moduleName === "notices") {
    return <AppShell role="admin"><AdminNoticesWorkspace /></AppShell>;
  }

  if (access.role === "admin" && moduleName === "fees") {
    return <AppShell role="admin"><AdminFinanceWorkspace mode="fees" /></AppShell>;
  }

  if (access.role === "admin" && moduleName === "invoices") {
    return <AppShell role="admin"><AdminFinanceWorkspace mode="invoices" /></AppShell>;
  }

  if (access.role === "admin" && moduleName === "finance-reports") {
    return <AppShell role="admin"><AdminFinanceWorkspace mode="reports" /></AppShell>;
  }

  if (access.role === "admin" && [
    "students", "parents", "teachers", "admissions", "timetable", "events", "notifications",
    "library", "transport", "inventory", "hr-payroll", "leave", "profile", "documents",
    "reports", "audit-logs", "settings",
  ].includes(moduleName)) {
    return <AppShell role="admin"><AdminDemoWorkspace module={moduleName as AdminDemoModule} /></AppShell>;
  }

  if (["class-logs", "classwork", "homework", "assignments", "projects", "study-material", "missed-activities"].includes(moduleName)) {
    return <AcademicWorkspace module={moduleName} />;
  }

  if (moduleName === "teacher-assignments") {
    return <TeacherAssignmentManager />;
  }

  if (access.role === "teacher") {
    const renderTeacherModule = (teacherModule: "exams" | "results" | "fees" | "profile") => (
      <AppShell role="teacher"><TeacherModuleView module={teacherModule} /></AppShell>
    );
    if (moduleName === "exams") return renderTeacherModule("exams");
    if (moduleName === "results" || moduleName === "result-report") return renderTeacherModule("results");
    if (moduleName === "fees") return renderTeacherModule("fees");
    if (moduleName === "profile") return renderTeacherModule("profile");
  }

  if (access.role === "admin") {
    return <AppShell role="admin"><AdminModulePlaceholder moduleName={moduleName} /></AppShell>;
  }

  return <GenericModule moduleName={moduleName} />;
}

/* =========================================================
   ATTENDANCE REGISTER
========================================================= */

function AttendanceRegister() {
  const [loading, setLoading] = useState(true);
  const [loadingAttendance, setLoadingAttendance] = useState(false);

  const [userId, setUserId] = useState<string | null>(null);
  const [teacherId, setTeacherId] = useState<string | null>(null);

  const [teacherName, setTeacherName] = useState("");
  const [teacherEmail, setTeacherEmail] = useState("");

  const [schoolId, setSchoolId] = useState<string | null>(null);
  const [academicYearId, setAcademicYearId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [classId, setClassId] = useState<string | null>(null);

  const [className, setClassName] = useState("");
  const [sectionName, setSectionName] = useState("");

  const [students, setStudents] = useState<StudentRow[]>([]);

  const [attendanceDate, setAttendanceDate] = useState(todayISO());

  const [attendance, setAttendance] = useState<AttendanceMap>({});

  const [registerModal, setRegisterModal] = useState(false);
  const [studentName, setStudentName] = useState("");
  const [registering, setRegistering] = useState(false);

  const [saving, setSaving] = useState(false);

  const [saveMessage, setSaveMessage] = useState("");
  const [saveMessageType, setSaveMessageType] = useState<
    "success" | "error"
  >("success");

  const [pageError, setPageError] = useState("");

  /* ---------------------------------------------------------
     SUCCESS / ERROR MESSAGE
  --------------------------------------------------------- */

  const showMessage = useCallback(
    (message: string, type: "success" | "error") => {
      setSaveMessage(message);
      setSaveMessageType(type);

      window.setTimeout(() => {
        setSaveMessage("");
      }, 5000);
    },
    []
  );

  /* ---------------------------------------------------------
     LOAD STUDENTS
  --------------------------------------------------------- */

  const loadStudents = useCallback(
    async (
      currentAcademicYearId: string,
      currentClassId: string,
      currentSectionId: string | null
    ) => {
      try {
        let query = supabase
          .from("enrollments")
          .select(
            `
            id,
            student_id,
            academic_year_id,
            class_id,
            section_id,
            roll_no,
            status
          `
          )
          .eq("academic_year_id", currentAcademicYearId)
          .eq("class_id", currentClassId)
          .eq("status", "active");

        if (currentSectionId) {
          query = query.eq("section_id", currentSectionId);
        }

        const { data: enrollmentData, error: enrollmentError } =
          await query;

        if (enrollmentError) {
          throw enrollmentError;
        }

        const studentIds = (enrollmentData || [])
          .map((row: any) => row.student_id)
          .filter(Boolean);

        if (!studentIds.length) {
          setStudents([]);
          return;
        }

        const { data: studentData, error: studentError } = await supabase
          .from("students")
          .select(
            `
            id,
            first_name,
            middle_name,
            last_name,
            admission_no,
            roll_no
          `
          )
          .in("id", studentIds);

        if (studentError) {
          throw studentError;
        }

        const studentMap = new Map(
          (studentData || []).map((student: any) => [student.id, student])
        );

        const result: StudentRow[] = (enrollmentData || [])
          .map((enrollment: any) => {
            const student = studentMap.get(enrollment.student_id);

            if (!student) return null;

            return {
              id: student.id,
              first_name: student.first_name,
              middle_name: student.middle_name,
              last_name: student.last_name,
              admission_no: student.admission_no,
              roll_no: enrollment.roll_no ?? student.roll_no ?? null,
            };
          })
          .filter(Boolean) as StudentRow[];

        result.sort((a, b) => {
          const aRoll = a.roll_no || "";
          const bRoll = b.roll_no || "";

          const aNum = Number(aRoll);
          const bNum = Number(bRoll);

          if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
            if (aNum !== bNum) {
              return aNum - bNum;
            }
          }

          if (aRoll !== bRoll) {
            return aRoll.localeCompare(bRoll, undefined, {
              numeric: true,
              sensitivity: "base",
            });
          }

          return formatStudentName(a).localeCompare(
            formatStudentName(b),
            undefined,
            {
              sensitivity: "base",
            }
          );
        });

        setStudents(result);
      } catch (error: any) {
        console.error("Load students error:", error);

        setPageError(
          error?.message || "Students could not be loaded."
        );
      }
    },
    []
  );

  /* ---------------------------------------------------------
     LOAD ATTENDANCE FOR SELECTED DATE
  --------------------------------------------------------- */

  const loadAttendanceForDate = useCallback(
    async (date: string) => {
      if (!academicYearId || !sectionId) {
        return;
      }

      setLoadingAttendance(true);

      try {
        const { data, error } = await supabase
          .from("attendance")
          .select(
            `
            student_id,
            status,
            attendance_date,
            academic_year_id,
            section_id
          `
          )
          .eq("academic_year_id", academicYearId)
          .eq("section_id", sectionId)
          .eq("attendance_date", date);

        if (error) {
          throw error;
        }

        const nextAttendance: AttendanceMap = {};

        (data || []).forEach((row: any) => {
          nextAttendance[row.student_id] =
            row.status as AttendanceStatus;
        });

        /*
         * New students default to Present in the UI.
         * They are only actually saved when Save Attendance is clicked.
         */
        students.forEach((student) => {
          if (!nextAttendance[student.id]) {
            nextAttendance[student.id] = "present";
          }
        });

        setAttendance(nextAttendance);
      } catch (error: any) {
        console.error("Attendance load error:", error);

        showMessage(
          error?.message || "Attendance could not be loaded.",
          "error"
        );
      } finally {
        setLoadingAttendance(false);
      }
    },
    [academicYearId, sectionId, students, showMessage]
  );

  /* ---------------------------------------------------------
     INITIAL LOAD
  --------------------------------------------------------- */

  const loadAttendanceRegister = useCallback(async () => {
    setLoading(true);
    setPageError("");

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError) {
        throw userError;
      }

      if (!user) {
        throw new Error("You are not logged in.");
      }

      setUserId(user.id);
      setTeacherEmail(user.email || "");

      /* -----------------------------------------------
         FIND TEACHER
      ----------------------------------------------- */

      const { data: teacher, error: teacherError } = await supabase
        .from("teachers")
        .select(
          `
          id,
          school_id,
          profile_id,
          full_name
        `
        )
        .eq("profile_id", user.id)
        .maybeSingle();

      if (teacherError) {
        throw teacherError;
      }

      if (!teacher) {
        throw new Error(
          "Teacher profile was not found for this login."
        );
      }

      setTeacherId(teacher.id);
      setSchoolId(teacher.school_id);
      setTeacherName(
        teacher.full_name || user.email || "Teacher"
      );

      /* -----------------------------------------------
         CURRENT ACADEMIC YEAR
      ----------------------------------------------- */

      const { data: academicYear, error: academicYearError } =
        await supabase
          .from("academic_years")
          .select("id, name, is_current")
          .eq("school_id", teacher.school_id)
          .eq("is_current", true)
          .maybeSingle();

      if (academicYearError) {
        throw academicYearError;
      }

      if (!academicYear) {
        throw new Error(
          "No current academic year is configured."
        );
      }

      setAcademicYearId(academicYear.id);

      /* -----------------------------------------------
         FIND CLASS TEACHER ASSIGNMENT
      ----------------------------------------------- */

      const { data: assignment, error: assignmentError } =
        await supabase
          .from("teacher_subject_assignments")
          .select(
            `
            id,
            teacher_id,
            academic_year_id,
            class_id,
            section_id,
            subject_id,
            is_class_teacher
          `
          )
          .eq("teacher_id", teacher.id)
          .eq("academic_year_id", academicYear.id)
          .eq("is_class_teacher", true)
          .limit(1)
          .maybeSingle();

      if (assignmentError) {
        throw assignmentError;
      }

      /*
       * No assignment = no attendance register.
       * We do NOT crash the page.
       */
      if (!assignment) {
        setPageError(
          "You are not assigned as a Class Teacher for this academic year."
        );

        setClassName("");
        setSectionName("");
        setStudents([]);

        return;
      }

      setClassId(assignment.class_id);
      setSectionId(assignment.section_id || null);

      /* -----------------------------------------------
         CLASS NAME
      ----------------------------------------------- */

      const { data: classData, error: classError } =
        await supabase
          .from("classes")
          .select("id, name")
          .eq("id", assignment.class_id)
          .single();

      if (classError) {
        throw classError;
      }

      setClassName(classData?.name || "");

      /* -----------------------------------------------
         SECTION NAME
      ----------------------------------------------- */

      if (assignment.section_id) {
        const { data: sectionData, error: sectionError } =
          await supabase
            .from("sections")
            .select("id, name")
            .eq("id", assignment.section_id)
            .single();

        if (sectionError) {
          throw sectionError;
        }

        setSectionName(sectionData?.name || "");
      } else {
        setSectionName("");
      }

      /* -----------------------------------------------
         STUDENTS
      ----------------------------------------------- */

      await loadStudents(
        academicYear.id,
        assignment.class_id,
        assignment.section_id || null
      );
    } catch (error: any) {
      console.error("Attendance Register Error:", error);

      setPageError(
        error?.message || "Attendance Register could not be loaded."
      );
    } finally {
      setLoading(false);
    }
  }, [loadStudents]);

  useEffect(() => {
    loadAttendanceRegister();
  }, [loadAttendanceRegister]);

  /* ---------------------------------------------------------
     LOAD ATTENDANCE WHEN STUDENTS / DATE ARE READY
  --------------------------------------------------------- */

  useEffect(() => {
    if (!academicYearId || !sectionId || !students.length) {
      return;
    }

    loadAttendanceForDate(attendanceDate);
  }, [
    academicYearId,
    sectionId,
    students,
    attendanceDate,
    loadAttendanceForDate,
  ]);

  /* ---------------------------------------------------------
     REGISTER STUDENT
  --------------------------------------------------------- */

  const registerStudent = async () => {
    const name = studentName.trim();

    if (!name) {
      showMessage("Please enter student name.", "error");
      return;
    }

    setRegistering(true);

    try {
      /*
       * Backend RPC automatically:
       * - creates student
       * - generates admission number
       * - generates roll number
       * - links student to this Class Teacher's class
       * - links current academic year
       * - links section
       */
      const { data, error } = await supabase.rpc(
        "register_student_for_class_teacher",
        {
          p_full_name: name,
        }
      );

      if (error) {
        throw error;
      }

      console.log("Registered student:", data);

      if (!academicYearId || !classId) {
        throw new Error(
          "Academic year or class information is missing."
        );
      }

      await loadStudents(
        academicYearId,
        classId,
        sectionId
      );

      setStudentName("");
      setRegisterModal(false);

      showMessage(
        `${name} registered successfully.`,
        "success"
      );
    } catch (error: any) {
      console.error("Register student error:", error);

      showMessage(
        error?.message || "Student could not be registered.",
        "error"
      );
    } finally {
      setRegistering(false);
    }
  };

  /* ---------------------------------------------------------
     CHANGE ATTENDANCE
  --------------------------------------------------------- */

  const setStudentAttendance = (
    studentId: string,
    status: AttendanceStatus
  ) => {
    setAttendance((previous) => ({
      ...previous,
      [studentId]: status,
    }));
  };

  /* ---------------------------------------------------------
     SAVE ATTENDANCE
  --------------------------------------------------------- */

  const saveAttendance = async () => {
    if (!userId) {
      showMessage("User session not found.", "error");
      return;
    }

    if (!schoolId) {
      showMessage("School information not found.", "error");
      return;
    }

    if (!academicYearId) {
      showMessage("Academic year not found.", "error");
      return;
    }

    if (!sectionId) {
      showMessage("Section is not assigned to this class teacher.", "error");
      return;
    }

    if (!students.length) {
      showMessage("No students registered.", "error");
      return;
    }

    setSaving(true);
    setSaveMessage("");

    try {
      /*
       * IMPORTANT:
       * attendance table requires:
       * school_id
       * academic_year_id
       * student_id
       * section_id
       * attendance_date
       * status
       */
      const rows = students.map((student) => ({
        school_id: schoolId,
        academic_year_id: academicYearId,
        student_id: student.id,
        section_id: sectionId,
        attendance_date: attendanceDate,
        status: attendance[student.id] || "present",
        marked_by: userId,
      }));

      const { error } = await supabase
        .from("attendance")
        .upsert(rows, {
          onConflict: "student_id,attendance_date",
        });

      if (error) {
        throw error;
      }

      showMessage(
        `Attendance saved successfully for ${students.length} students.`,
        "success"
      );

      await loadAttendanceForDate(attendanceDate);
    } catch (error: any) {
      console.error("Save attendance error:", error);

      showMessage(
        error?.message || "Attendance could not be saved.",
        "error"
      );
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------
     HOLIDAY
  --------------------------------------------------------- */

  const markHoliday = async () => {
    if (!userId) {
      showMessage("User session not found.", "error");
      return;
    }

    if (!schoolId) {
      showMessage("School information not found.", "error");
      return;
    }

    if (!academicYearId) {
      showMessage("Academic year not found.", "error");
      return;
    }

    if (!sectionId) {
      showMessage("Section is not assigned.", "error");
      return;
    }

    if (!students.length) {
      showMessage(
        "Register at least one student before marking a holiday.",
        "error"
      );
      return;
    }

    setSaving(true);
    setSaveMessage("");

    try {
      /*
       * Holiday is stored in the same attendance table
       * for every student.
       *
       * This means backend can tell:
       * 30-10-2026 = holiday
       *
       * No individual attendance is required for that day.
       */
      const holidayRows = students.map((student) => ({
        school_id: schoolId,
        academic_year_id: academicYearId,
        student_id: student.id,
        section_id: sectionId,
        attendance_date: attendanceDate,
        status: "holiday" as AttendanceStatus,
        remarks: "School/Class Holiday",
        marked_by: userId,
      }));

      const { error } = await supabase
        .from("attendance")
        .upsert(holidayRows, {
          onConflict: "student_id,attendance_date",
        });

      if (error) {
        throw error;
      }

      showMessage(
        `Holiday saved successfully for ${formatDateDisplay(
          attendanceDate
        )}.`,
        "success"
      );

      await loadAttendanceForDate(attendanceDate);
    } catch (error: any) {
      console.error("Holiday save error:", error);

      showMessage(
        error?.message || "Holiday could not be saved.",
        "error"
      );
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------
     DATE CHANGE
  --------------------------------------------------------- */

  const changeDate = (value: string) => {
    setAttendanceDate(value);
    setSaveMessage("");
  };

  /* ---------------------------------------------------------
     STATUS COUNTS
  --------------------------------------------------------- */

  const counts = useMemo(() => {
    let present = 0;
    let absent = 0;
    let late = 0;
    let halfDay = 0;
    let leave = 0;
    let holiday = 0;

    students.forEach((student) => {
      const status = attendance[student.id];

      if (status === "present") present++;
      if (status === "absent") absent++;
      if (status === "late") late++;
      if (status === "half_day") halfDay++;
      if (status === "leave") leave++;
      if (status === "holiday") holiday++;
    });

    return {
      present,
      absent,
      late,
      halfDay,
      leave,
      holiday,
    };
  }, [students, attendance]);

  /* ---------------------------------------------------------
     LOADING
  --------------------------------------------------------- */

  if (loading) {
    return (
      <div className="min-h-[60vh] rounded-2xl border border-slate-800 bg-[#0f172a] p-8 text-slate-200">
        <div className="animate-pulse">
          Loading Attendance Register...
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------
     PAGE
  --------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* HEADER */}

      <section className="rounded-2xl border border-slate-800 bg-[#0f172a] p-6 shadow-sm">
        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">
              Attendance Register
            </h1>

            <p className="mt-1 text-sm text-blue-300">
              Class Teacher:{" "}
              {teacherEmail || teacherName || "Teacher"}
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {className && (
                <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-sm font-medium text-white">
                  {className}
                </span>
              )}

              {sectionName && (
                <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-sm font-medium text-white">
                  Section {sectionName}
                </span>
              )}

              <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-sm font-medium text-white">
                {students.length} Students
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setRegisterModal(true)}
            disabled={!classId || !academicYearId}
            className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Register Student
          </button>
        </div>
      </section>

      {/* ERROR */}

      {pageError && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {pageError}
        </div>
      )}

      {/* SAVE MESSAGE */}

      {saveMessage && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm font-medium ${
            saveMessageType === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : "border-red-500/40 bg-red-500/10 text-red-400"
          }`}
        >
          {saveMessageType === "success" ? "✓ " : "✕ "}
          {saveMessage}
        </div>
      )}

      {/* DATE / ACTIONS */}

      <section className="rounded-2xl border border-slate-800 bg-[#0f172a] p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">
              Attendance Date
            </label>

            <input
              type="date"
              value={attendanceDate}
              onChange={(e) => changeDate(e.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-blue-500"
            />

            <p className="mt-2 text-xs text-slate-400">
              {formatDateDisplay(attendanceDate)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* HOLIDAY */}

            <button
              type="button"
              onClick={markHoliday}
              disabled={saving || loadingAttendance || !students.length}
              className="rounded-xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : "Holiday"}
            </button>

            {/* SAVE */}

            <button
              type="button"
              onClick={saveAttendance}
              disabled={
                saving ||
                loadingAttendance ||
                !students.length
              }
              className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Attendance"}
            </button>
          </div>
        </div>

        {/* COUNTS */}

        {students.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-slate-900 px-3 py-1 text-slate-300">
              Present: {counts.present}
            </span>

            <span className="rounded-full bg-slate-900 px-3 py-1 text-slate-300">
              Absent: {counts.absent}
            </span>

            <span className="rounded-full bg-slate-900 px-3 py-1 text-slate-300">
              Late: {counts.late}
            </span>

            <span className="rounded-full bg-slate-900 px-3 py-1 text-slate-300">
              Half Day: {counts.halfDay}
            </span>

            <span className="rounded-full bg-slate-900 px-3 py-1 text-slate-300">
              Leave: {counts.leave}
            </span>

            {counts.holiday > 0 && (
              <span className="rounded-full bg-slate-900 px-3 py-1 text-slate-300">
                Holiday: {counts.holiday}
              </span>
            )}
          </div>
        )}
      </section>

      {/* STUDENTS TABLE */}

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0f172a]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px]">
            <thead>
              <tr className="border-b border-slate-800 text-left">
                <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">
                  Roll No
                </th>

                <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">
                  Student
                </th>

                <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">
                  Admission No
                </th>

                <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">
                  Attendance
                </th>
              </tr>
            </thead>

            <tbody>
              {students.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-5 py-16 text-center"
                  >
                    <div className="text-lg font-semibold text-white">
                      No students registered
                    </div>

                    <div className="mt-2 text-sm text-slate-400">
                      Click “Register Student” to add the first student.
                    </div>
                  </td>
                </tr>
              ) : (
                students.map((student) => {
                  const currentStatus =
                    attendance[student.id] || "present";

                  const isHoliday =
                    currentStatus === "holiday";

                  return (
                    <tr
                      key={student.id}
                      className="border-b border-slate-800 last:border-b-0"
                    >
                      <td className="px-5 py-5 text-sm font-medium text-white">
                        {student.roll_no || "—"}
                      </td>

                      <td className="px-5 py-5 text-sm font-semibold text-white">
                        {formatStudentName(student)}
                      </td>

                      <td className="px-5 py-5 text-sm text-blue-300">
                        {student.admission_no}
                      </td>

                      <td className="px-5 py-5">
                        {isHoliday ? (
                          <div className="inline-flex rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-400">
                            Holiday
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {(
                              [
                                "present",
                                "absent",
                                "late",
                                "half_day",
                                "leave",
                              ] as AttendanceStatus[]
                            ).map((status) => (
                              <button
                                key={status}
                                type="button"
                                onClick={() =>
                                  setStudentAttendance(
                                    student.id,
                                    status
                                  )
                                }
                                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${statusButtonClass(
                                  currentStatus,
                                  status
                                )}`}
                              >
                                {statusLabel(status)}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* REGISTER STUDENT MODAL */}

      {registerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#0f172a] p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">
                  Register Student
                </h2>

                <p className="mt-1 text-sm text-slate-400">
                  Student will be added to your assigned class.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  if (!registering) {
                    setRegisterModal(false);
                    setStudentName("");
                  }
                }}
                className="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="mt-6">
              <label className="mb-2 block text-sm font-medium text-slate-300">
                Student Name
              </label>

              <input
                type="text"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !registering) {
                    registerStudent();
                  }
                }}
                placeholder="Enter student name"
                autoFocus
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-blue-500"
              />
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  if (!registering) {
                    setRegisterModal(false);
                    setStudentName("");
                  }
                }}
                disabled={registering}
                className="rounded-xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={registerStudent}
                disabled={registering || !studentName.trim()}
                className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {registering ? "Registering..." : "Register Student"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



/* =========================================================
   DAILY ACADEMIC LOG
========================================================= */

type TeacherAssignment = {
  id: string;
  teacher_id: string;
  academic_year_id: string;
  class_id: string;
  section_id: string | null;
  subject_id: string;
  is_class_teacher: boolean;
};

type AcademicAssignmentView = TeacherAssignment & {
  className: string;
  sectionName: string;
  subjectName: string;
};

/* =========================================================
   TEACHER ASSIGNMENT MANAGER - SCHOOL ADMIN
========================================================= */

type AssignmentManagerRow = {
  id: string;
  teacher_id: string;
  academic_year_id: string;
  class_id: string;
  section_id: string | null;
  subject_id: string;
  is_class_teacher: boolean;
  teacherName: string;
  employeeId: string;
  className: string;
  sectionName: string;
  subjectName: string;
  academicYearName: string;
};

type AssignmentOption = {
  id: string;
  name: string;
};

type SectionOption = {
  id: string;
  name: string;
  class_id: string;
};

function TeacherAssignmentManager() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentTeacherId, setCurrentTeacherId] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  const [schoolId, setSchoolId] = useState<string | null>(null);
  const [academicYearId, setAcademicYearId] = useState("");
  const [academicYearName, setAcademicYearName] = useState("");

  const [teachers, setTeachers] = useState<
    (AssignmentOption & { employeeId: string })[]
  >([]);
  const [classes, setClasses] = useState<AssignmentOption[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [subjects, setSubjects] = useState<AssignmentOption[]>([]);
  const [rows, setRows] = useState<AssignmentManagerRow[]>([]);

  const [teacherId, setTeacherId] = useState("");
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [isClassTeacher, setIsClassTeacher] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filterTeacher, setFilterTeacher] = useState("all");
  const [filterClass, setFilterClass] = useState("all");
  const [filterSubject, setFilterSubject] = useState("all");

  const showMessage = useCallback((text: string, type: "success" | "error") => {
    setMessage(text);
    setMessageType(type);
    window.setTimeout(() => setMessage(""), 5000);
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setClassId("");
    setSectionId("");
    setSubjectId("");
    setIsClassTeacher(false);
    if (isAdmin) setTeacherId("");
  };

  const loadManagerData = useCallback(async () => {
    setLoading(true);

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError) throw userError;
      if (!user) throw new Error("You are not logged in.");

      /* -----------------------------------------------------
         DETERMINE ROLE
         - Teacher: manages ONLY their own assignments.
         - School/Super Admin: full school-wide visibility/manage.
      ----------------------------------------------------- */
      const { data: roleRows, error: roleError } = await supabase
        .from("user_roles")
        .select("role, school_id")
        .eq("user_id", user.id);

      if (roleError) throw roleError;

      const adminRole = resolveUiRole(roleRows || []) === "admin";

      setIsAdmin(adminRole);

      let resolvedSchoolId: string | null =
        (roleRows || []).find((row: any) => row.school_id)?.school_id || null;

      let resolvedTeacherId: string | null = null;

      const { data: teacher, error: teacherError } = await supabase
        .from("teachers")
        .select("id, school_id, profile_id, full_name, employee_id")
        .eq("profile_id", user.id)
        .maybeSingle();

      if (teacherError) throw teacherError;

      if (teacher) {
        resolvedTeacherId = teacher.id;
        resolvedSchoolId = teacher.school_id;
        setCurrentTeacherId(teacher.id);
      }

      if (!resolvedSchoolId) {
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("school_id")
          .eq("id", user.id)
          .maybeSingle();

        if (profileError) throw profileError;
        resolvedSchoolId = profile?.school_id || null;
      }

      if (!resolvedSchoolId) {
        throw new Error("School information was not found for this account.");
      }

      setSchoolId(resolvedSchoolId);

      if (!adminRole && !resolvedTeacherId) {
        throw new Error("Teacher profile was not found for this login.");
      }

      /* CURRENT ACADEMIC YEAR */
      const { data: year, error: yearError } = await supabase
        .from("academic_years")
        .select("id, name, school_id")
        .eq("school_id", resolvedSchoolId)
        .eq("is_current", true)
        .order("start_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (yearError) throw yearError;
      if (!year) throw new Error("No current academic year was found.");

      setAcademicYearId(year.id);
      setAcademicYearName(year.name);

      /* LOOKUP DATA */
      const [teachersResult, classesResult, sectionsResult, subjectsResult] =
        await Promise.all([
          adminRole
            ? supabase
                .from("teachers")
                .select("id, full_name, employee_id")
                .eq("school_id", resolvedSchoolId)
                .order("full_name", { ascending: true })
            : supabase
                .from("teachers")
                .select("id, full_name, employee_id")
                .eq("id", resolvedTeacherId),
          supabase
            .from("classes")
            .select("id, name")
            .eq("school_id", resolvedSchoolId)
            .eq("is_active", true)
            .order("sort_order", { ascending: true }),
          supabase
            .from("sections")
            .select("id, name, class_id")
            .eq("school_id", resolvedSchoolId)
            .order("name", { ascending: true }),
          supabase
            .from("subjects")
            .select("id, name")
            .eq("school_id", resolvedSchoolId)
            .eq("is_active", true)
            .order("name", { ascending: true }),
        ]);

      if (teachersResult.error) throw teachersResult.error;
      if (classesResult.error) throw classesResult.error;
      if (sectionsResult.error) throw sectionsResult.error;
      if (subjectsResult.error) throw subjectsResult.error;

      const teacherOptions = (teachersResult.data || []).map((item: any) => ({
        id: item.id,
        name: item.full_name || item.employee_id || "Unnamed Teacher",
        employeeId: item.employee_id || "",
      }));

      setTeachers(teacherOptions);
      setClasses((classesResult.data || []) as AssignmentOption[]);
      setSections((sectionsResult.data || []) as SectionOption[]);
      setSubjects((subjectsResult.data || []) as AssignmentOption[]);

      if (!adminRole && resolvedTeacherId) {
        setTeacherId(resolvedTeacherId);
      }

      const teacherMap = new Map(
        teacherOptions.map((item) => [item.id, item])
      );
      const classMap = new Map(
        (classesResult.data || []).map((item: any) => [item.id, item.name])
      );
      const sectionMap = new Map(
        (sectionsResult.data || []).map((item: any) => [item.id, item.name])
      );
      const subjectMap = new Map(
        (subjectsResult.data || []).map((item: any) => [item.id, item.name])
      );

      let assignmentQuery = supabase
        .from("teacher_subject_assignments")
        .select(
          "id, teacher_id, academic_year_id, class_id, section_id, subject_id, is_class_teacher"
        )
        .eq("academic_year_id", year.id);

      if (!adminRole && resolvedTeacherId) {
        assignmentQuery = assignmentQuery.eq("teacher_id", resolvedTeacherId);
      }

      const { data: assignmentData, error: assignmentError } =
        await assignmentQuery;

      if (assignmentError) throw assignmentError;

      const formatted: AssignmentManagerRow[] =
        (assignmentData || []).map((item: any) => {
          const teacherOption = teacherMap.get(item.teacher_id);

          return {
            id: item.id,
            teacher_id: item.teacher_id,
            academic_year_id: item.academic_year_id,
            class_id: item.class_id,
            section_id: item.section_id,
            subject_id: item.subject_id,
            is_class_teacher: Boolean(item.is_class_teacher),
            teacherName: teacherOption?.name || "Unknown Teacher",
            employeeId: teacherOption?.employeeId || "",
            className: classMap.get(item.class_id) || "Unknown Class",
            sectionName: item.section_id
              ? sectionMap.get(item.section_id) || "Unknown Section"
              : "All Sections",
            subjectName: subjectMap.get(item.subject_id) || "Unknown Subject",
            academicYearName: year.name,
          };
        });

      formatted.sort((a, b) => {
        const left = `${a.className}-${a.sectionName}-${a.subjectName}`;
        const right = `${b.className}-${b.sectionName}-${b.subjectName}`;
        return left.localeCompare(right);
      });

      setRows(formatted);
    } catch (error: any) {
      console.error("Teacher assignment manager load error:", error);
      showMessage(
        error?.message || "Teaching assignments could not be loaded.",
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, [showMessage]);

  useEffect(() => {
    void loadManagerData();
  }, [loadManagerData]);

  const filteredSections = useMemo(
    () => sections.filter((item) => !classId || item.class_id === classId),
    [sections, classId]
  );

  useEffect(() => {
    if (
      sectionId &&
      !filteredSections.some((item) => item.id === sectionId)
    ) {
      setSectionId("");
    }
  }, [filteredSections, sectionId]);

  const saveAssignment = async () => {
    if (!academicYearId) {
      showMessage("Current academic year is missing.", "error");
      return;
    }

    const targetTeacherId = isAdmin ? teacherId : currentTeacherId;

    if (!targetTeacherId || !classId || !sectionId || !subjectId) {
      showMessage(
        "Class, Section and Subject are required.",
        "error"
      );
      return;
    }

    setSaving(true);

    try {
      /* -----------------------------------------------------
         ONE CLASS TEACHER PER TEACHER + ACADEMIC YEAR
      ----------------------------------------------------- */
      if (isClassTeacher) {
        const { data: existingTeacherClassTeacher, error: classTeacherError } =
          await supabase
            .from("teacher_subject_assignments")
            .select("id, class_id, section_id")
            .eq("teacher_id", targetTeacherId)
            .eq("academic_year_id", academicYearId)
            .eq("is_class_teacher", true);

        if (classTeacherError) throw classTeacherError;

        const conflictingTeacherRole =
          (existingTeacherClassTeacher || []).find(
            (item: any) => item.id !== editingId
          );

        if (conflictingTeacherRole) {
          throw new Error(
            "A teacher can be Class Teacher of only one class + section in the same academic year."
          );
        }

        /* ---------------------------------------------------
           ONE CLASS TEACHER PER CLASS + SECTION
        --------------------------------------------------- */
        const { data: existingSectionClassTeacher, error: sectionRoleError } =
          await supabase
            .from("teacher_subject_assignments")
            .select("id, teacher_id")
            .eq("academic_year_id", academicYearId)
            .eq("class_id", classId)
            .eq("section_id", sectionId)
            .eq("is_class_teacher", true);

        if (sectionRoleError) throw sectionRoleError;

        const conflictingSectionRole =
          (existingSectionClassTeacher || []).find(
            (item: any) => item.id !== editingId
          );

        if (conflictingSectionRole) {
          throw new Error(
            "This class + section already has a Class Teacher. You can still add this teacher as a Subject Teacher."
          );
        }
      }

      let existingQuery = supabase
        .from("teacher_subject_assignments")
        .select("id")
        .eq("teacher_id", targetTeacherId)
        .eq("academic_year_id", academicYearId)
        .eq("class_id", classId)
        .eq("subject_id", subjectId);

      existingQuery = sectionId
        ? existingQuery.eq("section_id", sectionId)
        : existingQuery.is("section_id", null);

      const { data: existingAssignment, error: existingError } =
        await existingQuery.maybeSingle();

      if (existingError) throw existingError;

      if (existingAssignment?.id && existingAssignment.id !== editingId) {
        throw new Error(
          "This class + section + subject is already in your teaching assignments."
        );
      }

      const payload = {
        teacher_id: targetTeacherId,
        academic_year_id: academicYearId,
        class_id: classId,
        section_id: sectionId,
        subject_id: subjectId,
        is_class_teacher: isClassTeacher,
      };

      if (editingId) {
        let updateQuery = supabase
          .from("teacher_subject_assignments")
          .update(payload)
          .eq("id", editingId);

        if (!isAdmin && currentTeacherId) {
          updateQuery = updateQuery.eq("teacher_id", currentTeacherId);
        }

        const { error } = await updateQuery;
        if (error) throw error;

        showMessage("Teaching assignment updated successfully.", "success");
      } else {
        const { error } = await supabase
          .from("teacher_subject_assignments")
          .insert(payload);

        if (error) throw error;

        showMessage("Teaching assignment added successfully.", "success");
      }

      resetForm();
      await loadManagerData();
    } catch (error: any) {
      console.error("Save teacher assignment error:", error);
      showMessage(
        error?.message || "Teaching assignment could not be saved.",
        "error"
      );
    } finally {
      setSaving(false);
    }
  };

  const editAssignment = (row: AssignmentManagerRow) => {
    if (!isAdmin && row.teacher_id !== currentTeacherId) {
      showMessage("You can only edit your own assignments.", "error");
      return;
    }

    setEditingId(row.id);
    if (isAdmin) setTeacherId(row.teacher_id);
    setClassId(row.class_id);
    setSectionId(row.section_id || "");
    setSubjectId(row.subject_id);
    setIsClassTeacher(row.is_class_teacher);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const deleteAssignment = async (row: AssignmentManagerRow) => {
    if (!isAdmin && row.teacher_id !== currentTeacherId) {
      showMessage("You can only remove your own assignments.", "error");
      return;
    }

    const confirmed = window.confirm(
      `Remove ${row.className} - ${row.sectionName} → ${row.subjectName}?`
    );

    if (!confirmed) return;

    setSaving(true);

    try {
      let deleteQuery = supabase
        .from("teacher_subject_assignments")
        .delete()
        .eq("id", row.id);

      if (!isAdmin && currentTeacherId) {
        deleteQuery = deleteQuery.eq("teacher_id", currentTeacherId);
      }

      const { error } = await deleteQuery;
      if (error) throw error;

      if (editingId === row.id) resetForm();

      showMessage("Teaching assignment removed successfully.", "success");
      await loadManagerData();
    } catch (error: any) {
      console.error("Delete teacher assignment error:", error);
      showMessage(
        error?.message || "Teaching assignment could not be removed.",
        "error"
      );
    } finally {
      setSaving(false);
    }
  };

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();

    return rows.filter((row) => {
      if (filterTeacher !== "all" && row.teacher_id !== filterTeacher) {
        return false;
      }

      if (filterClass !== "all" && row.class_id !== filterClass) {
        return false;
      }

      if (filterSubject !== "all" && row.subject_id !== filterSubject) {
        return false;
      }

      if (!q) return true;

      return [
        row.teacherName,
        row.employeeId,
        row.className,
        row.sectionName,
        row.subjectName,
        row.academicYearName,
        row.is_class_teacher ? "class teacher" : "subject teacher",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, filterTeacher, filterClass, filterSubject]);

  const classTeacherCount = rows.filter((row) => row.is_class_teacher).length;

  if (loading) {
    return (
      <div className="min-h-[60vh] rounded-2xl border border-slate-800 bg-[#0f172a] p-8 text-slate-200">
        Loading Teaching Assignments...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-800 bg-[#0f172a] p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">
              {isAdmin ? "Teaching Assignments" : "My Teaching Assignments"}
            </h1>
            <p className="mt-1 text-sm text-blue-300">
              Academic Year: {academicYearName || "Current Year"}
            </p>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              {isAdmin
                ? "School-wide teacher assignments manage karein."
                : "Aap apni classes, sections aur subjects khud add, edit aur remove kar sakte hain. Kisi approval ki zarurat nahi hai."}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-3">
            {isAdmin && (
              <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3">
                <div className="text-lg font-bold text-white">{teachers.length}</div>
                <div className="text-slate-500">Teachers</div>
              </div>
            )}
            <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3">
              <div className="text-lg font-bold text-white">{rows.length}</div>
              <div className="text-slate-500">Assignments</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3">
              <div className="text-lg font-bold text-emerald-300">{classTeacherCount}</div>
              <div className="text-slate-500">Class Teachers</div>
            </div>
          </div>
        </div>
      </section>

      {message && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm font-medium ${
            messageType === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : "border-red-500/40 bg-red-500/10 text-red-400"
          }`}
        >
          {messageType === "success" ? "✓ " : "✕ "}
          {message}
        </div>
      )}

      <section className="rounded-2xl border border-slate-800 bg-[#0f172a] p-6">
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">
              {editingId ? "Edit Assignment" : "Add Teaching Assignment"}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {isAdmin
                ? "Kisi bhi teacher ke liye assignment create kar sakte hain."
                : "Apne liye multiple classes aur subjects add kar sakte hain."}
            </p>
          </div>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
            >
              Cancel Edit
            </button>
          )}
        </div>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {isAdmin && (
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300">Teacher</label>
              <select
                value={teacherId}
                onChange={(e) => setTeacherId(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-blue-500"
              >
                <option value="">Select Teacher</option>
                {teachers.map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>
                    {teacher.name}{teacher.employeeId ? ` — ${teacher.employeeId}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Class</label>
            <select
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setSectionId("");
              }}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-blue-500"
            >
              <option value="">Select Class</option>
              {classes.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Section</label>
            <select
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
              disabled={!classId}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-blue-500 disabled:opacity-50"
            >
              <option value="">Select Section</option>
              {filteredSections.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Subject</label>
            <select
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-blue-500"
            >
              <option value="">Select Subject</option>
              {subjects.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-medium text-white">Class Teacher</div>
            <div className="mt-1 text-xs text-slate-400">
              Ek teacher ek academic year me sirf ek Class + Section ka Class Teacher ho sakta hai.
            </div>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={isClassTeacher}
              onChange={(e) => setIsClassTeacher(e.target.checked)}
              className="h-5 w-5 rounded border-slate-700 bg-slate-900 text-blue-600"
            />
            <span className="text-sm font-semibold text-emerald-300">Mark as Class Teacher</span>
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={saveAssignment}
            disabled={saving}
            className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : editingId ? "Update Assignment" : "+ Add Assignment"}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-[#0f172a] p-6">
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-white">Find Assignments</h2>
          <p className="mt-1 text-sm text-slate-400">Class, subject, teacher ya section se quickly find karo.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Search</label>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Teacher / Class / Subject / Section..."
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-blue-500"
            />
          </div>

          {isAdmin && (
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300">Teacher Filter</label>
              <select
                value={filterTeacher}
                onChange={(e) => setFilterTeacher(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-blue-500"
              >
                <option value="all">All Teachers</option>
                {teachers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Class Filter</label>
            <select
              value={filterClass}
              onChange={(e) => setFilterClass(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-blue-500"
            >
              <option value="all">All Classes</option>
              {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Subject Filter</label>
            <select
              value={filterSubject}
              onChange={(e) => setFilterSubject(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-blue-500"
            >
              <option value="all">All Subjects</option>
              {subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0f172a]">
        <div className="border-b border-slate-800 p-6">
          <h2 className="text-lg font-semibold text-white">{isAdmin ? "All Teaching Assignments" : "My Teaching Assignments"}</h2>
          <p className="mt-1 text-sm text-slate-400">Showing {visibleRows.length} of {rows.length} assignments.</p>
        </div>

        {visibleRows.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            No teaching assignments found. Add your first class + subject above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr className="border-b border-slate-800 text-left">
                  {isAdmin && <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">Teacher</th>}
                  <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">Class</th>
                  <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">Section</th>
                  <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">Subject</th>
                  <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">Role</th>
                  <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-blue-300">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-800 last:border-b-0">
                    {isAdmin && (
                      <td className="px-5 py-5">
                        <div className="font-semibold text-white">{row.teacherName}</div>
                        {row.employeeId && <div className="mt-1 text-xs text-slate-500">{row.employeeId}</div>}
                      </td>
                    )}
                    <td className="px-5 py-5 text-sm font-medium text-white">{row.className}</td>
                    <td className="px-5 py-5 text-sm text-slate-300">{row.sectionName}</td>
                    <td className="px-5 py-5 text-sm font-semibold text-blue-300">{row.subjectName}</td>
                    <td className="px-5 py-5">
                      {row.is_class_teacher ? (
                        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">Class Teacher</span>
                      ) : (
                        <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300">Subject Teacher</span>
                      )}
                    </td>
                    <td className="px-5 py-5">
                      <div className="flex gap-2">
                        <button type="button" onClick={() => editAssignment(row)} className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-semibold text-blue-300 hover:bg-blue-500/20">Edit</button>
                        <button type="button" onClick={() => void deleteAssignment(row)} disabled={saving} className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/20 disabled:opacity-50">Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5">
        <h3 className="font-semibold text-blue-300">Teacher Dashboard Flow</h3>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          Teacher apne assignments khud manage karta hai → Daily Academic Log me wahi classes/subjects milte hain → academic work Supabase me save hota hai → related students aur parents ko unka relevant academic history mil sakta hai. Admin ko school-wide full access milta hai.
        </p>
      </section>
    </div>
  );
}

/* =========================================================
   GENERIC MODULE
========================================================= */

function GenericModule({
  moduleName,
}: {
  moduleName: string;
}) {
  const title = moduleName
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return (
    <div className="rounded-2xl border border-slate-800 bg-[#0f172a] p-8">
      <h1 className="text-2xl font-bold text-white">
        {title}
      </h1>

      <p className="mt-2 text-sm text-slate-400">
        This module is ready for its dedicated management screen.
      </p>
    </div>
  );
}