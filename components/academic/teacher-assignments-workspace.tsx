"use client";

import { useState } from "react";
import { SubstituteCoverageWorkspace } from "./substitute-coverage-workspace";
import { TeachingAssignmentManager } from "./teaching-assignment-manager";

export function TeacherAssignmentsWorkspace({ userId, showCoverage }: { userId: string; showCoverage: boolean }) {
  const [assignmentRevision, setAssignmentRevision] = useState(0);
  return <div className="space-y-6">
    {showCoverage && <SubstituteCoverageWorkspace userId={userId} assignmentRevision={assignmentRevision} />}
    <TeachingAssignmentManager onChanged={() => setAssignmentRevision((value) => value + 1)} />
  </div>;
}
