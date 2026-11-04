import { readCsvRows, validCsvCell } from "@/lib/csv";

export const maxAssignmentCsvBytes = 64 * 1024;
export const maxAssignmentImportRows = 50;
export const assignmentCsvTemplate = "employee_id,class_name,section_name,subject_name,is_class_teacher\nEXAMPLE-T01,Class 6,A,Mathematics,false\n";

export type AssignmentImportInput = {
  employeeId: string;
  className: string;
  sectionName: string;
  subjectName: string;
  isClassTeacher: boolean;
};

export type AssignmentCsvRow = AssignmentImportInput & { rowNumber: number; issue: string | null };

export function parseAssignmentCsv(text: string): AssignmentCsvRow[] {
  if (new TextEncoder().encode(text).byteLength > maxAssignmentCsvBytes) {
    throw new Error("Choose a CSV file that is 64 KB or smaller.");
  }
  const [header, ...rows] = readCsvRows(text);
  if (header?.length !== 5 || header.map((value) => value.trim()).join(",") !== assignmentCsvTemplate.split("\n")[0]) {
    throw new Error("Use these template columns in order: employee_id, class_name, section_name, subject_name, is_class_teacher.");
  }
  if (!rows.length || rows.length > maxAssignmentImportRows) {
    throw new Error(`Include between 1 and ${maxAssignmentImportRows} assignment rows.`);
  }

  const seenAssignments = new Map<string, number>();
  const seenClassTeacherDuties = new Map<string, number>();
  const seenClassTeachers = new Map<string, number>();
  return rows.map((row, index) => {
    const [employeeId = "", className = "", sectionName = "", subjectName = "", flag = ""] = row.map((value) => value.trim());
    const isClassTeacher = flag.toLowerCase() === "true";
    const rowNumber = index + 1;
    let issue = null;

    if (row.length !== 5) issue = "Use all five template columns.";
    else if (!employeeId || !validCsvCell(employeeId, 64)) issue = "Enter an employee ID up to 64 characters.";
    else if ([className, sectionName, subjectName].some((name) => !name || !validCsvCell(name, 100))) {
      issue = "Enter class, section and subject names up to 100 characters each.";
    } else if (!["true", "false"].includes(flag.toLowerCase())) issue = "Use true or false for is_class_teacher.";
    else {
      const assignmentKey = JSON.stringify([employeeId, className, sectionName, subjectName]);
      const classTeacherKey = JSON.stringify([className, sectionName]);
      const duplicateRow = seenAssignments.get(assignmentKey);
      const dutyRow = isClassTeacher ? seenClassTeacherDuties.get(classTeacherKey) : undefined;
      const teacherRow = isClassTeacher ? seenClassTeachers.get(employeeId) : undefined;
      if (duplicateRow) issue = `This assignment repeats row ${duplicateRow}.`;
      else if (dutyRow) issue = `Row ${dutyRow} already assigns a class teacher for this class and section.`;
      else if (teacherRow) issue = `Row ${teacherRow} already assigns a class-teacher duty to this teacher.`;
      seenAssignments.set(assignmentKey, duplicateRow ?? rowNumber);
      if (isClassTeacher) {
        seenClassTeacherDuties.set(classTeacherKey, dutyRow ?? rowNumber);
        seenClassTeachers.set(employeeId, teacherRow ?? rowNumber);
      }
    }

    return { employeeId, className, sectionName, subjectName, isClassTeacher, rowNumber, issue };
  });
}
