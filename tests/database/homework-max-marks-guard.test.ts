// @vitest-environment node
import {randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {createHomeworkSubmissionDatabase} from "./homework-submissions-fixture";
import {asStaffActor,STAFF_IDS as actor,STAFF_ROWS as rows} from "./staff-scope-fixture";

const A=rows.A;
const directory=new URL("../../supabase/migrations/",import.meta.url);

describe("homework maximum marks cannot be cleared under graded marks",()=>{
  let db:Awaited<ReturnType<typeof createHomeworkSubmissionDatabase>>;
  const submit=()=>asStaffActor<{result:{id:string}}>(db,actor.studentA,
    "select public.submit_homework($1,$2,$3,$4,$5,$6) result",[A.activity,"My answer",null,null,randomUUID(),null]);
  const grade=(id:string,marks:number|null,feedback:string)=>asStaffActor(db,actor.teacherA,
    "select public.grade_homework($1,$2,$3,$4,$5) result",[id,marks,feedback,0,randomUUID()]);
  const save=async(maxMarks:number|null,title="Homework A")=>{
    const log=(await db.query<{updated_at:string}>("select updated_at::text from public.class_logs where id=$1",[A.log])).rows[0];
    const payload={id:A.log,school_id:actor.schoolA,academic_year_id:A.year,class_id:A.class,section_id:A.section,subject_id:A.subject,
      log_date:"2026-11-02",topic:"QA daily work",status:"published",expected_updated_at:log.updated_at};
    return asStaffActor(db,actor.teacherA,"select public.save_academic_log($1::jsonb,$2::jsonb) id",
      [JSON.stringify(payload),JSON.stringify([{id:A.activity,activity_type:"homework",title,max_marks:maxMarks}])]);
  };
  const maxMarks=async()=>(await db.query<{max_marks:string|null}>("select max_marks::text from public.class_activities where id=$1",[A.activity])).rows[0].max_marks;

  beforeAll(async()=>{
    db=await createHomeworkSubmissionDatabase();
    const file=(await readdir(directory)).find(name=>name.endsWith("_guard_cleared_homework_max_marks.sql"));
    if(!file) throw new Error("Missing homework max-marks guard migration.");
    await db.exec(await readFile(new URL(file,directory),"utf8"));
  },30000);
  beforeEach(async()=>{
    await db.exec("delete from app_private.homework_write_receipts; delete from public.activity_submissions");
    await db.query("update public.class_logs set status='published' where id=$1",[A.log]);
    await db.query("update public.class_activities set max_marks=10,title='Homework A' where id=$1",[A.activity]);
  });
  afterAll(async()=>{await db?.close();});

  it("refuses clearing or lowering the maximum below a graded mark, but allows raising it",async()=>{
    const id=(await submit()).rows[0].result.id; await grade(id,8,"Good");
    await expect(save(null)).rejects.toMatchObject({code:"23503"});
    expect(await maxMarks()).toBe("10");
    await expect(save(5)).rejects.toMatchObject({code:"23503"});
    expect(await maxMarks()).toBe("10");
    await save(20); expect(await maxMarks()).toBe("20");
  });

  it("still allows clearing the maximum when submissions carry no marks",async()=>{
    const id=(await submit()).rows[0].result.id; await grade(id,null,"Feedback only");
    await save(null); expect(await maxMarks()).toBeNull();
  });

  it("lets a legacy activity that already has no maximum under graded marks save unchanged or renamed",async()=>{
    const id=(await submit()).rows[0].result.id; await grade(id,8,"Good");
    // Legacy state from before the guard (written as owner, bypassing the trigger's client checks).
    await db.query("update public.class_activities set max_marks=null where id=$1",[A.activity]);
    await save(null);
    await save(null,"Homework A (revised)");
    expect((await db.query<{title:string;max_marks:string|null}>("select title,max_marks::text from public.class_activities where id=$1",[A.activity])).rows[0])
      .toEqual({title:"Homework A (revised)",max_marks:null});
    await save(10); expect(await maxMarks()).toBe("10");
  });
});
