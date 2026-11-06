const uuid = (number) => `74000000-0000-0000-0000-${String(number).padStart(12, "0")}`;

export const recoveryIds = Object.freeze({
  schoolA: uuid(1), schoolB: uuid(2),
  adminA: uuid(10), adminB: uuid(11), teacherA: uuid(12), guardianA: uuid(13),
  studentUserA: uuid(14), studentUserB: uuid(15), claimantA: uuid(16),
  yearA: uuid(20), yearB: uuid(21), classA: uuid(30), classB: uuid(31),
  sectionA: uuid(40), sectionB: uuid(41), subjectA: uuid(50), subjectB: uuid(51),
  teacherRecordA: uuid(60), assignmentA: uuid(61), parentA: uuid(70),
  pupilA: uuid(80), unlinkedPupilA: uuid(81), pupilB: uuid(82),
  attendanceA: uuid(90), attendanceUnlinkedA: uuid(91), attendanceB: uuid(92),
  structureA: uuid(100), structureB: uuid(101), feeA: uuid(110), feeUnlinkedA: uuid(111), feeB: uuid(112),
  paymentA: uuid(120), paymentB: uuid(121), assessmentA: uuid(130), markA: uuid(131), noticeA: uuid(140),
});

/** Only synthetic records in a freshly replayed embedded database, never Auth API calls. */
export async function seedRecoveryData(db) {
  const id = recoveryIds;
  await db.exec("begin");
  try {
    for (const [schoolId, name, code] of [
      [id.schoolA, "Synthetic recovery school A", "RECOVERY-A"],
      [id.schoolB, "Synthetic recovery school B", "RECOVERY-B"],
    ]) await db.query("insert into public.schools(id,name,code) values($1,$2,$3)", [schoolId, name, code]);

    for (const [userId, label, schoolId, role] of [
      [id.adminA, "admin-a", id.schoolA, "school_admin"],
      [id.adminB, "admin-b", id.schoolB, "school_admin"],
      [id.teacherA, "teacher-a", id.schoolA, "teacher"],
      [id.guardianA, "guardian-a", id.schoolA, "parent"],
      [id.studentUserA, "student-a", id.schoolA, "student"],
      [id.studentUserB, "student-b", id.schoolB, "student"],
      [id.claimantA, "unlinked-claimant-a", null, null],
    ]) {
      const email = `${label}@recovery.invalid`;
      await db.query("insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)", [
        userId, email, JSON.stringify({ full_name: `Synthetic ${label}` }),
      ]);
      // The real app's Auth trigger may already have created this profile.
      await db.query(`insert into public.profiles(id,school_id,full_name,email)
        values($1,$2,$3,$4) on conflict(id) do update set school_id=excluded.school_id,
          full_name=excluded.full_name,email=excluded.email`, [userId, schoolId, `Synthetic ${label}`, email]);
      if (role) await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [userId, schoolId, role]);
    }

    for (const side of ["A", "B"]) {
      await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
        values($1,$2,'2026–27 Recovery','2026-04-01','2027-03-31',true)`, [id[`year${side}`], id[`school${side}`]]);
      await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Recovery class 6')", [id[`class${side}`], id[`school${side}`]]);
      await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Recovery A')", [id[`section${side}`], id[`school${side}`], id[`class${side}`]]);
      await db.query("insert into public.subjects(id,school_id,name) values($1,$2,'Recovery science')", [id[`subject${side}`], id[`school${side}`]]);
      await db.query(`insert into public.fee_structures(id,school_id,academic_year_id,class_id,name,amount)
        values($1,$2,$3,$4,'Recovery tuition',1000)`, [id[`structure${side}`], id[`school${side}`], id[`year${side}`], id[`class${side}`]]);
    }
    await db.query(`insert into public.teachers(id,school_id,profile_id,employee_id,full_name)
      values($1,$2,$3,'RECOVERY-TEACHER-A','Synthetic recovery teacher')`, [id.teacherRecordA, id.schoolA, id.teacherA]);
    await db.query(`insert into public.teacher_subject_assignments
      (id,teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
      values($1,$2,$3,$4,$5,$6,true)`, [id.assignmentA, id.teacherRecordA, id.yearA, id.classA, id.sectionA, id.subjectA]);

    for (const [pupilId, schoolId, profileId, admission, yearId, classId, sectionId] of [
      [id.pupilA, id.schoolA, id.studentUserA, "REC-A-001", id.yearA, id.classA, id.sectionA],
      [id.unlinkedPupilA, id.schoolA, null, "REC-A-002", id.yearA, id.classA, id.sectionA],
      [id.pupilB, id.schoolB, id.studentUserB, "REC-B-001", id.yearB, id.classB, id.sectionB],
    ]) {
      await db.query(`insert into public.students(id,school_id,profile_id,admission_no,first_name,dob,registered_mobile)
        values($1,$2,$3,$4,'Synthetic recovery pupil','2014-06-15','0000000000')`, [pupilId, schoolId, profileId, admission]);
      await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [pupilId, yearId, classId, sectionId]);
    }
    await db.query("insert into public.parents(id,school_id,profile_id,guardian_code) values($1,$2,$3,'REC-GUARDIAN-A')", [id.parentA, id.schoolA, id.guardianA]);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilA, id.parentA]);

    for (const [markId, pupilId, schoolId, yearId, sectionId, status] of [
      [id.attendanceA, id.pupilA, id.schoolA, id.yearA, id.sectionA, "absent"],
      [id.attendanceUnlinkedA, id.unlinkedPupilA, id.schoolA, id.yearA, id.sectionA, "late"],
      [id.attendanceB, id.pupilB, id.schoolB, id.yearB, id.sectionB, "present"],
    ]) await db.query(`insert into public.attendance(id,school_id,academic_year_id,section_id,student_id,attendance_date,status)
      values($1,$2,$3,$4,$5,'2026-11-05',$6)`, [markId, schoolId, yearId, sectionId, pupilId, status]);

    for (const [feeId, schoolId, pupilId, structureId] of [
      [id.feeA, id.schoolA, id.pupilA, id.structureA],
      [id.feeUnlinkedA, id.schoolA, id.unlinkedPupilA, id.structureA],
      [id.feeB, id.schoolB, id.pupilB, id.structureB],
    ]) await db.query(`insert into public.student_fees(id,school_id,student_id,fee_structure_id,billing_period,due_date,amount,status)
      values($1,$2,$3,$4,'2026-11','2026-11-30',1000,'pending')`, [feeId, schoolId, pupilId, structureId]);
    for (const [paymentId, schoolId, pupilId, feeId, receipt] of [
      [id.paymentA, id.schoolA, id.pupilA, id.feeA, "RECOVERY-RECEIPT-A"],
      [id.paymentB, id.schoolB, id.pupilB, id.feeB, "RECOVERY-RECEIPT-B"],
    ]) await db.query(`insert into public.fee_payments(id,school_id,student_id,student_fee_id,receipt_no,amount,payment_method,status)
      values($1,$2,$3,$4,$5,250,'cash','paid')`, [paymentId, schoolId, pupilId, feeId, receipt]);

    await db.query(`insert into public.teacher_assessments(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
      values($1,$2,$3,$4,$5,$6,$7,'Synthetic recovery assessment','2026-11-05',100)`, [
      id.assessmentA, id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA,
    ]);
    await db.query("insert into public.teacher_assessment_marks(id,assessment_id,student_id,marks_obtained) values($1,$2,$3,74)", [id.markA, id.assessmentA, id.pupilA]);
    await db.query(`insert into public.notices(id,school_id,title,content,audience,published_at,created_by)
      values($1,$2,'Synthetic recovery notice','No delivery is performed',$3,now()-interval '1 day',$4)`, [
      id.noticeA, id.schoolA, JSON.stringify({ roles: ["student", "parent", "teacher", "staff"] }), id.adminA,
    ]);
    await db.exec("commit");
    return id;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
