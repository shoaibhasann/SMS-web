import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AttendanceComposition, AttendanceSegments, DashboardGreeting, DashboardIdentity, DashboardMetric, DashboardPanel, DashboardViewAll, RecentLogChart } from "@/components/dashboard/dashboard-primitives";

describe("dashboard presentation from verified records", () => {
  it("keeps summary content keyboard-scrollable while the full-view action stays outside its scroll region", () => {
    const title = "A long real school update that remains readable in a bounded preview";
    render(<DashboardPanel title="School updates" right={<DashboardViewAll href="/modules/notices" />}>
      <ul>{Array.from({ length: 12 }, (_, n) => <li key={n}>{title} {n + 1}</li>)}</ul>
    </DashboardPanel>);
    const preview = screen.getByRole("region", { name: "School updates preview" });
    expect(preview).toHaveAttribute("tabindex", "0");
    expect(within(preview).getAllByRole("listitem")).toHaveLength(12);
    expect(within(preview).getByText(`${title} 12`)).toBeInTheDocument();
    expect(preview).not.toContainElement(screen.getByRole("link", { name: "View all" }));
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/modules/notices");
  });
  it("lets workflow cards opt out so forms and critical actions never inherit preview caps", () => {
    render(<DashboardPanel title="Attendance editor" preview={false}><form aria-label="Record attendance"><label>Class<select><option>A</option></select></label><button type="submit">Save attendance</button></form></DashboardPanel>);
    const section = screen.getByRole("heading", { name: "Attendance editor" }).closest("section");
    expect(section).not.toHaveClass("dashboard-preview-panel");
    expect(screen.queryByRole("region", { name: "Attendance editor preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save attendance" })).toBeEnabled();
  });
  it("uses a compact role greeting with a real action and no decorative hero gradient", () => {
    render(<DashboardGreeting eyebrow="School administration" title="School Admin Dashboard" description="Your school overview." href="/modules/students" action="Manage students" />);
    const heading = screen.getByRole("heading", { name: "School Admin Dashboard" });
    expect(heading.closest("header")).toHaveClass("dashboard-greeting"); expect(heading.closest("header")).not.toHaveClass("gradient");
    expect(screen.getByRole("link", { name: "Manage students" })).toHaveAttribute("href", "/modules/students");
    expect(heading.closest("header")?.querySelector("time")).toHaveAttribute("datetime", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });
  it("shows canonical money/unknown values without growth claims or zero fallbacks", () => {
    render(<><DashboardMetric label="Net collection" value="₹850.00" context="Recorded this month" featured /><DashboardMetric label="Unavailable metric" value="—" /></>);
    expect(screen.getByText("Net collection").closest("article")).toHaveClass("is-featured");
    expect(within(screen.getByText("Net collection").closest("article")!).getByText("₹850.00")).toBeInTheDocument();
    expect(within(screen.getByText("Unavailable metric").closest("article")!).getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/growth|\+\d+%|last month/i)).not.toBeInTheDocument();
  });
  it("builds the attendance graphic and visible legend only from supplied status counts", () => {
    render(<AttendanceComposition rows={[{ status: "present" }, { status: "present" }, { status: "absent" }, { status: "holiday" }]} href="/modules/attendance" />);
    const chart = screen.getByRole("img", { name: /4 saved attendance records/ });
    expect(chart).toHaveAttribute("aria-label", expect.stringContaining("Present 2")); expect(chart).toHaveAttribute("aria-label", expect.stringContaining("Absent 1"));
    const legend = screen.getByRole("list"); expect(within(legend).getAllByRole("listitem")).toHaveLength(3);
    expect(within(legend).getByText("Holiday")).toBeInTheDocument(); expect(screen.queryByText("75%")).not.toBeInTheDocument();
  });
  it("keeps absent/other-status aggregate semantics rather than claiming all other pupils are present", () => {
    render(<AttendanceSegments title="Today’s attendance" detail="Saved records" href="/modules/attendance" segments={[{ label: "Absent", count: 8, color: "#df5871" }, { label: "Other statuses", count: 34, color: "#3867ff" }]} />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "42 saved attendance records: Absent 8, Other statuses 34");
    expect(screen.getByText("Other statuses")).toBeInTheDocument(); expect(screen.queryByText("Present")).not.toBeInTheDocument();
  });
  it("renders explicit empty/error attendance states without a fabricated chart", () => {
    const view = render(<AttendanceComposition rows={[]} href="/modules/attendance" />);
    expect(screen.getByText(/No attendance records available/)).toBeInTheDocument(); expect(screen.queryByRole("img")).not.toBeInTheDocument();
    view.rerender(<AttendanceComposition rows={[{ status: "present" }]} unavailable href="/modules/attendance" />);
    expect(screen.getByText(/Attendance is unavailable/)).toBeInTheDocument(); expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/Attendance is unavailable/)).toHaveClass("dashboard-unavailable"); expect(screen.getByText(/Attendance is unavailable/)).not.toHaveTextContent(/Refresh/);
  });
  it("aggregates actual log dates and labels a recent sample instead of inventing a monthly trend", () => {
    render(<RecentLogChart logs={[{ log_date: "2026-11-05" }, { log_date: "2026-11-05" }, { log_date: "2026-11-06" }]} />);
    const chart = screen.getByRole("img", { name: /Recent academic log sample/ });
    expect(chart).toHaveAttribute("aria-label", "Recent academic log sample, 3 logs: 2026-11-05 2, 2026-11-06 1");
    expect(chart.querySelectorAll("rect")).toHaveLength(2); expect(screen.getByText(/record sample, not a complete school trend/)).toBeInTheDocument();
  });
  it("does not draw fictional learning bars when the loaded sample is empty", () => {
    render(<RecentLogChart logs={[]} />); expect(screen.queryByRole("img")).not.toBeInTheDocument(); expect(screen.getByText(/once recorded/)).toBeInTheDocument();
  });
  it("keeps identity initials separate from accessible verified profile data", () => {
    render(<DashboardIdentity label="Child Details" name="QA Anya" subtitle="Verified linked student" details={[{ label: "Admission", value: "QA-1" }, { label: "Class", value: "Class 6" }]} />);
    const section = screen.getByRole("heading", { name: "Child Details" }).closest("section")!;
    expect(within(section).getByText("QA Anya")).toBeInTheDocument(); expect(within(section).getByText("QA-1")).toBeInTheDocument();
    expect(within(section).getByText("QA")).toHaveAttribute("aria-hidden", "true");
    expect(within(section).queryByRole("link")).not.toBeInTheDocument();
  });
});
