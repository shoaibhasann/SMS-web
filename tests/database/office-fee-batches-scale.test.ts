// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createStaffScopeDatabase>>;
type Preview = { preview_token: string; can_post: boolean; rows: { admission_no: string }[]; summary: { ready_count: number; existing_count: number; ready_amount: number; error_count: number } };
type Receipt = { batch_id: string; total_amount: number; created_count: number };

describe("fee batch school-size bounds and transaction rollback", () => {
  let db: Database;
  const { schoolA, accountantA } = STAFF_IDS;
  const { A } = STAFF_ROWS;
  let today: string;
  const monthly = (period: string) => ({ academic_year_id: A.year, fee_structure_id: A.structure, class_id: A.class, section_id: A.section, billing_period: period, due_date: `${period}-20` });
  async function preview(kind: string, payload: unknown) {
    return (await asStaffActor<{ value: Preview }>(db, accountantA,
      "select public.preview_office_fee_batch($1,$2,$3::jsonb) as value", [schoolA, kind, JSON.stringify(payload)])).rows[0].value;
  }
  async function post(kind: string, payload: unknown, token: string, request = randomUUID()) {
    return (await asStaffActor<{ value: Receipt }>(db, accountantA,
      "select public.post_office_fee_batch($1,$2,$3::jsonb,$4,$5) as value", [schoolA, kind, JSON.stringify(payload), token, request])).rows[0].value;
  }
  beforeAll(async () => {
    db = await createStaffScopeDatabase();
    const directory = new URL("../../supabase/migrations/", import.meta.url), files = await readdir(directory);
    for (const suffix of ["_record_office_fee_payment.sql", "_office_fee_batches_and_opening_balances.sql"]) {
      const matches = files.filter((name) => name.endsWith(suffix));
      expect(matches).toHaveLength(1);
      await db.exec(await readFile(new URL(matches[0], directory), "utf8"));
    }
    today = (await db.query<{ day: string }>("select (statement_timestamp() at time zone 'Asia/Kolkata')::date::text as day")).rows[0].day;
    await db.query(`with added as (
      insert into public.students(school_id,admission_no,first_name)
      select $1,'SCALE-'||n,'Scale pupil '||n from generate_series(1,1499) n returning id
    ) insert into public.enrollments(student_id,academic_year_id,class_id,section_id)
      select id,$2,$3,$4 from added`, [schoolA, A.year, A.class, A.section]);
  }, 30000);
  afterAll(async () => { await db?.close(); });

  it("previews and posts all 1,500 monthly charges without truncating the reviewed roster", async () => {
    const payload = monthly("2026-11"), start = performance.now(), reviewed = await preview("monthly", payload);
    const previewMs = Math.round(performance.now() - start), postStart = performance.now();
    expect(reviewed.rows).toHaveLength(1500);
    expect(reviewed.summary).toMatchObject({ ready_count: 1500, ready_amount: 1500000, error_count: 0 });
    const receipt = await post("monthly", payload, reviewed.preview_token);
    const postMs = Math.round(performance.now() - postStart);
    expect(receipt).toMatchObject({ created_count: 1500, total_amount: 1500000 });
    expect((await db.query("select count(*)::int as count from public.student_fees where school_id=$1 and billing_period='2026-11'", [schoolA])).rows[0]).toEqual({ count: 1500 });
    console.info(`Local 1500-pupil monthly batch: preview ${previewMs} ms, post ${postMs} ms.`);
  });

  it("maps and posts 1,500 opening balances without making cash receipts", async () => {
    const pupils = (await db.query<{ admission_no: string }>("select s.admission_no from public.students s join public.enrollments e on e.student_id=s.id where s.school_id=$1 and e.academic_year_id=$2 and e.class_id=$3 and e.section_id=$4 order by s.id", [schoolA, A.year, A.class, A.section])).rows;
    const payload = { academic_year_id: A.year, as_of_date: today, source_reference: "SCALE-REVIEW", reason: "Reviewed synthetic opening debt", rows: pupils.map((row) => ({ admission_no: row.admission_no, amount: "1.25" })) };
    const start = performance.now(), reviewed = await preview("opening", payload), previewMs = Math.round(performance.now() - start);
    expect(reviewed.rows).toHaveLength(1500); expect(reviewed.can_post).toBe(true);
    expect(reviewed.summary).toMatchObject({ ready_count: 1500, ready_amount: 1875, error_count: 0 });
    const beforePayments = (await db.query("select id from public.fee_payments order by id")).rows;
    const postStart = performance.now(), receipt = await post("opening", payload, reviewed.preview_token), postMs = Math.round(performance.now() - postStart);
    expect(receipt).toMatchObject({ created_count: 1500, total_amount: 1875 });
    expect((await db.query("select id from public.fee_payments order by id")).rows).toEqual(beforePayments);
    expect((await db.query("select count(*)::int as count from app_private.office_fee_openings where school_id=$1", [schoolA])).rows[0]).toEqual({ count: 1500 });
    console.info(`Local 1500-pupil opening batch: preview ${previewMs} ms, post ${postMs} ms.`);
  });

  it("rolls back earlier posted rows and the batch audit if a later insert fails", async () => {
    const payload = monthly("2027-02"), reviewed = await preview("monthly", payload), request = randomUUID();
    await db.exec(`create function public.reject_second_batch_charge() returns trigger language plpgsql set search_path='' as $$
      begin
        if new.billing_period='2027-02' and exists(select 1 from public.student_fees f where f.school_id=new.school_id and f.billing_period=new.billing_period) then
          raise exception 'Injected later-row failure' using errcode='22023';
        end if;
        return new;
      end;
      $$;
      create trigger reject_second_batch_charge before insert on public.student_fees for each row execute function public.reject_second_batch_charge();`);
    await expect(post("monthly", payload, reviewed.preview_token, request)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select count(*)::int as count from public.student_fees where school_id=$1 and billing_period='2027-02'", [schoolA])).rows[0]).toEqual({ count: 0 });
    expect((await db.query("select count(*)::int as count from app_private.office_fee_batches where request_id=$1", [request])).rows[0]).toEqual({ count: 0 });
    await db.exec("drop trigger reject_second_batch_charge on public.student_fees; drop function public.reject_second_batch_charge()");
  });

  it("rejects 1,501 eligible pupils rather than silently omitting the last pupil", async () => {
    const pupil = (await db.query<{ id: string }>("insert into public.students(school_id,admission_no,first_name) values($1,'SCALE-1500','Too many') returning id", [schoolA])).rows[0].id;
    await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [pupil, A.year, A.class, A.section]);
    await expect(preview("monthly", monthly("2027-03"))).rejects.toMatchObject({ code: "22023" });
    const rows = Array.from({ length: 1501 }, (_, index) => ({ admission_no: `PUPIL-${index}`, amount: "1.00" }));
    await expect(preview("opening", { academic_year_id: A.year, as_of_date: today, source_reference: "BOUNDS", reason: "Test bounds", rows })).rejects.toMatchObject({ code: "22023" });
  });
});
