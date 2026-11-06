import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingState, WorkspaceSkeleton } from "@/components/ui/skeleton";
import { DashboardIdentity, DashboardMetric } from "@/components/dashboard/dashboard-primitives";

describe("neutral accessible loading UI", () => {
  it("announces progress without inventing a role, navigation or demo records before authorization", () => {
    const { container } = render(<WorkspaceSkeleton />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading your workspace…")).toBeInTheDocument();
    expect(container.querySelector('[data-skeleton="dashboard"]')).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/admin|teacher|student|₹|42|63%/i)).not.toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it.each(["list", "table", "form", "cards", "dashboard"] as const)("uses non-interactive %s shapes while retaining its real progress announcement", (variant) => {
    const { container } = render(<LoadingState variant={variant}>Loading permitted records…</LoadingState>);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Loading permitted records…")).toBeInTheDocument();
    expect(container.querySelector(`[data-skeleton="${variant}"]`)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("does not expose an old child identity or a fake zero while that scope is loading", () => {
    const view = render(<><DashboardIdentity label="Child Details" name="Old pupil" subtitle="Old account" details={[{ label: "Admission", value: "OLD-1" }]} loading /><DashboardMetric label="Attendance" value="0%" context="Retained records" loading /></>);
    expect(screen.getByRole("heading", { name: "Child Details" })).toBeInTheDocument();
    expect(screen.queryByText("Old pupil")).not.toBeInTheDocument();
    expect(screen.queryByText("OLD-1")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    view.rerender(<DashboardMetric label="Attendance" value="63%" context="Retained records" />);
    expect(screen.getByText("63%")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
