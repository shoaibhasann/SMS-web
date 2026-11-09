# SMS founder input

## 1. Who is the first school, and who can approve a pilot?

The first pilot school is not confirmed yet. We plan to target a private school in Firozabad or nearby cities, with approximately 300–1,500 students, covering Playway to Class 12.

Initially, we will approach the school management, Principal or Director to get approval for a 10-day pilot.

The school will be selected based on its willingness to test the software with real operational data and provide feedback before commercial rollout.

## 2. Which recurring task costs the school the most time or causes the most mistakes?

Manual attendance management and parent communication are major operational challenges in schools.

Teachers often use paper registers or spreadsheets to record attendance. Administrators have to collect, verify and maintain these records manually.

This process can consume significant time, create errors and make it difficult for parents to stay updated about their children's attendance.

We want to measure the time spent on daily attendance, delayed submissions, correction requests and missed parent follow-ups during the pilot.

## 3. What is the one workflow the pilot must deliver?

Outcome and deferral
Our objective is to launch SMS as a complete, commercially sellable School Management ERP rather than a limited attendance-only product.

The software should be ready to demonstrate and sell to schools, covering the complete student lifecycle and daily school operations.

Core modules must include Admissions, Student Management, Staff Management, Attendance, Fees, Homework, Classwork, Examinations, Marks, Report Cards, Parent Portal, Student Portal, Notifications, Timetable, Reports and Role-Based Access Control.

Each core module must have working database integration, proper permissions, validated workflows and acceptance testing.

The system must support a complete school setup, including school registration, academic sessions, classes, sections, subjects, staff assignments, student imports and guardian invitations.

We will prepare a professional demo environment with realistic sample data, a sales demonstration, pricing packages and an onboarding process.

Advanced modules such as Transport, Library, Payroll and Inventory will also be part of the product roadmap and will be offered commercially only after implementation and testing.

The goal is to be able to pitch the product, close a school subscription and begin onboarding immediately after approval.

## 4. Who uses the pilot, and what may each role change?

SMS will support a comprehensive role-based access control system.

The system will include the following roles:

1. Super Admin – Platform-level management, school creation, subscription management and system configuration.
2. School Admin – Complete school-level administration, user management, student records, academic setup and permissions.
3. Principal – School-wide monitoring, approvals, academic oversight and reports.
4. Accountant / Finance – Fee structures, payments, receipts, dues and financial reports.
5. Teachers – Assigned classes, attendance, homework, classwork, marks and student progress.
6. Parents / Guardians – Access only to their verified linked children's attendance, fees, homework, notices and results.
7. Students – Access to their own attendance, homework, timetable, marks and academic records.
8. Department Staff – Separate restricted access for transport, library and HR operations.

The School Admin will assign teachers to classes and sections. In case of teacher absence, an authorised Admin or Principal can assign a substitute teacher.

Teachers can update their assigned academic records but cannot approve their own restricted historical corrections or modify school-wide settings.

All sensitive changes must follow appropriate approval workflows and maintain audit logs.

The system must support configurable permissions, ensuring that every role can access only the modules and records authorised for them.

Guardians must never be able to access unrelated students' information.

## 5. How will we get the roster into the system and keep it current?

SMS must provide a complete Student and Staff Data Import and Management System.

Schools should be able to import existing records using Excel or CSV templates instead of entering every record manually.

The system must support bulk imports for:

- Students
- Parents and Guardians
- Teachers and Staff
- Classes and Sections
- Subjects and Academic Assignments

The import system must include downloadable templates, column mapping, validation, duplicate detection, error reports and a preview before final import.

Each student must have a unique school-specific student ID and admission number.

The School Admin will be responsible for uploading and verifying records. The system must maintain an import history and audit trail.

New admissions, transfers, section changes, withdrawals and academic session promotions must be manageable through the Admin dashboard.

Guardian relationships must be verified before accounts are linked.

For the first school onboarding, a reviewed one-time bulk import is acceptable. Future integrations with existing school software can be developed separately.

The system must also support safe data updates without accidentally overwriting existing student records or attendance history.

## 6. How should a guardian get or lose access to a child?

SMS must provide a secure Guardian Verification and Child Linking System.

The School Admin will verify the guardian's relationship using the school's admission records before granting access.

Guardians will receive a secure invitation through their registered mobile number or email. Account activation will require identity verification through OTP or another approved verification method.

The system must support:

- Multiple children linked to one guardian account.
- Multiple authorised guardians linked to one student.
- Separate guardian permissions where required.
- Secure, expiring invitations and invitation resend functionality.
- Guardian account recovery and registered mobile number updates.
- Access revocation and re-verification.
- Immediate restriction of access when an authorised administrator removes a guardian relationship.

When a student transfers or leaves the school, the school must be able to deactivate the student's active enrolment and manage guardian access according to school policy.

All guardian linking, unlinking and permission changes must be recorded in an audit log.

The School Admin will own guardian verification, access approvals, recovery requests and removal cases.

Strict school-level and student-level data isolation must ensure that guardians can only access their verified children.

## 7. What are the school’s attendance rules?

SMS must provide a comprehensive and configurable Attendance Management System.

The system should support both daily attendance and period-wise attendance, allowing each school to configure its preferred attendance method.

Attendance statuses must include:

- Present
- Absent
- Late
- Half Day
- On Leave

Teachers can mark attendance only for their assigned classes and sections.

Each school can configure its own attendance submission cutoff time. Unsubmitted attendance must remain marked as Pending and should not automatically convert every unmarked student to Absent.

The system should provide automated pending attendance alerts on the Admin dashboard.

Historical attendance corrections must follow an approval workflow. Teachers can submit correction requests with a mandatory reason. The authorised School Admin or Principal can approve or reject these requests.

Every change must maintain a complete audit trail containing the original status, updated status, reason, timestamp and identity of the person making and approving the change.

The system must support daily, monthly, student-wise, class-wise and school-wide attendance reports, including attendance percentages and late arrival summaries.

Schools must be able to configure cutoff times, correction permissions and historical correction windows according to their policies.

Attendance records must remain protected from unauthorised modification and must be retained according to the school's data retention policy.

## 8. What do families need to see or receive?

SMS must provide a comprehensive Parent and Guardian Portal with access to their linked children's school information.

Parents should be able to view:

1. Student profile and academic details.
2. Daily and historical attendance.
3. Monthly attendance summaries.
4. Homework and classwork.
5. Timetable and examination schedules.
6. Marks, grades and published report cards.
7. Fee dues, payment history and receipts.
8. Leave applications and approval status.
9. School notices, announcements and important updates.
10. Teacher-shared academic updates.

The Parent Portal must support English and Hindi.

Parents must be able to switch between multiple linked children through one account, with strict data isolation to prevent access to unrelated students.

Notification System – Initial Release

The initial commercial release will support only:

- In-app notifications.
- Mobile push notifications.

Important notification events should include:

- Student absent or late.
- Homework assigned.
- Fee due reminders.
- Fee payment confirmations.
- Examination schedules.
- Published results.
- Important school announcements.
- Leave application updates.

The system must include notification preferences, unread notification counts, notification history and delivery status.

Parents should receive notifications according to their linked children and authorised permissions. Teachers and administrators should also receive role-specific notifications.

Schools should be able to configure notification preferences and control which events trigger notifications.

WhatsApp, SMS and Email integrations will remain outside the initial release scope to avoid additional operational costs. These integrations may be introduced in future phases based on school demand.

The School Admin will manage notification settings, while authorised teachers can send permitted class-related updates.

## 9. What should come immediately after the pilot?

Workflow and owner
Our priority is to complete the entire SMS before approaching schools for commercial sales.

We do not want to launch or pitch the product as a limited attendance-only or pilot-only solution.

The complete commercial version must include all major school management modules:

1. Admissions and Student Management.
2. Teacher and Staff Management.
3. Classes, Sections and Subjects.
4. Attendance Management.
5. Fees and Financial Management.
6. Homework and Classwork.
7. Examinations, Marks and Report Cards.
8. Parent and Student Portals.
9. Timetable Management.
10. Notifications and Announcements.
11. Transport Management.
12. Library Management.
13. HR and Payroll.
14. Inventory Management.
15. Reports and Analytics.
16. School Settings and Role-Based Access Control.

Every advertised module must be fully implemented, connected to the production database, permission-tested and functionally verified.

The system must support independent school accounts, complete school onboarding, bulk data import, guardian invitations, academic session management and secure data isolation.

The Super Admin must be able to create and manage schools and subscriptions.

Before commercial pitching, we must complete end-to-end testing, security and permission testing, mobile responsiveness, backup and recovery procedures, deployment, demo data preparation, documentation and onboarding workflows.

The development and product team will own implementation and quality assurance. School-specific customisations and third-party integrations can be handled separately based on commercial requirements.

The goal is to have a complete, stable, professional and commercially sellable ERP so that we can demonstrate it, close a subscription and immediately begin onboarding a school.

No major advertised feature should be presented as complete until it has passed its acceptance tests.

## 10. What earns sign-off, and who gives it?

Our sign-off criteria will be based on complete commercial product readiness, not merely completion of a limited school pilot.

Before commercial pitching and sales, SMS must meet the following requirements:

1. All advertised core ERP modules must be fully implemented and operational.
2. All user roles and permissions must pass end-to-end testing.
3. Student, guardian, teacher and school data must remain securely isolated.
4. Attendance, fees, admissions, academics and reporting workflows must pass acceptance testing.
5. Bulk data import, guardian invitations and school onboarding must work correctly.
6. The application must be responsive across desktop, tablet and mobile devices.
7. Notifications, receipts, reports and dashboards must use actual database data.
8. Production deployment, database backups, recovery procedures and error monitoring must be verified.
9. No critical security issues, data integrity issues or unresolved release-blocking bugs should remain.
10. A professional demo environment, product documentation, pricing packages and onboarding process must be ready.

The Founder/Product Owner will provide final internal product sign-off after reviewing the completed system and QA evidence.

The development and QA teams will be responsible for implementation, testing and technical verification. The founder will handle commercial pitching, pricing decisions and sales strategy. Initial school onboarding and staff training will be supported by the implementation team.

We aim to sell SMS through school-wise subscription packages based on student strength, selected modules and support requirements. Final pricing will be decided before commercial launch.

The product must be ready for immediate demonstration, subscription activation and school onboarding after a successful sales discussion.

There will be no fixed 10-day pilot limitation on the overall product development. A school may receive a demonstration or an optional evaluation period, but the commercial product must be ready before we begin pitching.

The final launch decision will be made by the Founder after reviewing functional testing, security, deployment and commercial readiness.
