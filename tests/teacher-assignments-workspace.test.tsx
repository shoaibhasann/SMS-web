import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeacherAssignmentsWorkspace } from "@/components/academic/teacher-assignments-workspace";

const { manager } = vi.hoisted(() => ({ manager: { onChanged: undefined as undefined | (() => void) } }));
vi.mock("@/components/academic/teaching-assignment-manager", () => ({
  TeachingAssignmentManager: ({ onChanged }: { onChanged?: () => void }) => { manager.onChanged = onChanged; return <section aria-label="Teaching assignment workspace" />; },
}));
vi.mock("@/components/academic/substitute-coverage-workspace", () => ({
  SubstituteCoverageWorkspace: ({ userId, assignmentRevision }: { userId: string; assignmentRevision?: number }) =>
    <section aria-label="Substitute attendance workspace">{userId}:{assignmentRevision}</section>,
}));

describe("teacher assignments page", () => {
  it("refreshes the coverage panel after each confirmed assignment change", () => {
    render(<TeacherAssignmentsWorkspace userId="admin" showCoverage />);
    const coverage = screen.getByRole("region", { name: "Substitute attendance workspace" });
    expect(coverage).toHaveTextContent("admin:0");
    act(() => manager.onChanged?.()); expect(coverage).toHaveTextContent("admin:1");
    act(() => manager.onChanged?.()); expect(coverage).toHaveTextContent("admin:2");
  });
  it("shows only the assignment manager to teachers", () => {
    render(<TeacherAssignmentsWorkspace userId="teacher" showCoverage={false} />);
    expect(screen.queryByRole("region", { name: "Substitute attendance workspace" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Teaching assignment workspace" })).toBeInTheDocument();
  });
});
