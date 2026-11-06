import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { familyNotificationsChangedEvent, familyNotificationsHref, loadFamilyNotificationInbox, loadFamilyNotificationUnreadCount, markAllFamilyNotificationsRead, markFamilyNotificationRead, notificationHref, notifyFamilyNotificationsChanged, type FamilyNotification } from "@/lib/notifications/family";
import { getFamilyNotificationResult } from "@/lib/result-publication";
import { getFamilyNotificationLeave } from "@/lib/student-leave";
import { familyResult, resultMetadata, resultUuid } from "./result-publication-fixture";
const id = resultUuid;
const stamp = "2026-11-06T10:00:00.123456+00:00";
const row = (patch: Partial<FamilyNotification> = {}): FamilyNotification => ({ id: id(1), kind: "absence", student_id: id(2), student_name: "QA child", created_at: stamp, read_at: null, event_date: "2026-11-06", source_id: id(3), status: "absent", title: "Absent today", assessment_id: null, ...patch });
function client(data: unknown, error: {code: string} | null = null) {
  const abortSignal = vi.fn().mockResolvedValue({data,error});
  const rpc = vi.fn().mockReturnValue(Object.assign(Promise.resolve({data,error}),{abortSignal}));
  return {rpc,abortSignal,client:{rpc} as unknown as SupabaseClient};
}
const inbox = (rows: FamilyNotification[] = [row()]) => ({notifications: rows, unread_count:"5", next_cursor:null});
describe("family notification trust boundary", () => {
  it("sends server-side unread and full keyset filters with cancellation", async () => {
    const before = {created_at:stamp,kind:"absence" as const,id:id(9)}, saved = client(inbox());
    const signal = new AbortController().signal;
    expect((await loadFamilyNotificationInbox(saved.client,{role:"parent",unreadOnly:true,cursor:before,limit:5},signal)).unread_count).toBe(5);
    expect(saved.rpc).toHaveBeenCalledWith("get_family_notification_inbox",{p_role:"parent",p_unread_only:true,p_limit:5,p_before_created_at:stamp,p_before_kind:"absence",p_before_id:id(9)});
    expect(saved.abortSignal).toHaveBeenCalledWith(signal);
  });
  it("retains exact cursor precision and strips unknown payload fields", async () => {
    const saved=client({...inbox(),notifications:[{...row(),private_reason:"secret"}],next_cursor:{created_at:stamp,kind:"absence",id:id(1)}});
    const loaded=await loadFamilyNotificationInbox(saved.client,{role:"student",limit:1});
    expect(loaded.next_cursor?.created_at).toBe(stamp); expect(loaded.notifications[0]).not.toHaveProperty("private_reason");
  });
  it.each([
    {notifications:[row(),row()]}, {notifications:[row({event_date:"2026-02-30"})]}, {notifications:[row({kind:"result_published",status:"published"})]},
    {notifications:[row({source_id:"../admin"})]}, {notifications:[row({read_at:"bad"})]}, {unread_count:"9007199254740992"},
    {next_cursor:{id:id(9),kind:"absence",created_at:stamp}}, {next_cursor:undefined},
  ])("rejects malformed, duplicate and mismapped inbox responses %j", async patch => {
    await expect(loadFamilyNotificationInbox(client({...inbox(),...patch}).client,{role:"parent"})).rejects.toThrow("could not be verified");
  });
  it("rejects invalid role, count, cursor and unread results", async () => {
    const saved=client(inbox());
    await expect(loadFamilyNotificationInbox(saved.client,{role:"admin" as "parent"})).rejects.toThrow("valid family");
    await expect(loadFamilyNotificationInbox(saved.client,{role:"parent",limit:51})).rejects.toThrow();
    await expect(loadFamilyNotificationInbox(saved.client,{role:"parent",cursor:{created_at:stamp,kind:"absence",id:"bad"}})).rejects.toThrow();
    expect(saved.rpc).not.toHaveBeenCalled();
    await expect(loadFamilyNotificationInbox(client(inbox([row({read_at:stamp})])).client,{role:"parent",unreadOnly:true})).rejects.toThrow();
    await expect(loadFamilyNotificationInbox(client({...inbox(),next_cursor:{id:id(1),kind:"absence",created_at:stamp}}).client,{role:"parent",cursor:{id:id(1),kind:"absence",created_at:stamp}})).rejects.toThrow();
  });
  it("validates count and atomic mutation acknowledgements without inventing read state", async () => {
    expect(await loadFamilyNotificationUnreadCount(client("31").client,"parent")).toBe(31);
    expect(await markAllFamilyNotificationsRead(client("31").client,"student")).toBe(31);
    expect(await markFamilyNotificationRead(client(stamp).client,"parent","absence",id(1))).toBe(stamp);
    expect(await markFamilyNotificationRead(client(null).client,"parent","leave_decision",id(1))).toBeNull();
    await expect(markAllFamilyNotificationsRead(client(-1).client,"student")).rejects.toThrow();
    await expect(markFamilyNotificationRead(client("ok").client,"student","result_published",id(1))).rejects.toThrow();
  });
  it.each([['42501','access changed'],['PGRST202','latest school update'],['500','could not be confirmed']])("normalizes %s error without exposing server internals", async (code,message) => {
    await expect(loadFamilyNotificationUnreadCount(client(null,{code}).client,"parent")).rejects.toThrow(message);
  });
  it("builds local role-specific child and exact-source links only", () => {
    expect(familyNotificationsHref("parent")).toBe("/modules/notifications?view=guardian");
    const result=new URL(notificationHref(row({kind:"result_published",status:"published",assessment_id:id(4)}),"parent"),"https://school.test");
    expect(result.pathname).toBe("/modules/results");expect(result.searchParams.get("view")).toBe("guardian");expect(result.searchParams.get("child")).toBe(id(2));expect(result.searchParams.get("assessment")).toBe(id(4));
    const leave=new URL(notificationHref(row({kind:"leave_decision",status:"approved"}),"student"),"https://school.test");
    expect(leave.pathname).toBe("/modules/student-leave");expect(leave.searchParams.has("view")).toBe(false);expect(leave.searchParams.get("request")).toBe(id(3));
    expect(notificationHref(row(),"parent")).toContain("/modules/attendance?");
  });
  it("broadcasts a scoped refresh hint without an untrusted count", () => {
    const listener=vi.fn(); window.addEventListener(familyNotificationsChangedEvent,listener);
    try { notifyFamilyNotificationsChanged("guardian-a","parent");expect(listener.mock.calls[0][0].detail).toEqual({userId:"guardian-a",role:"parent"}); }
    finally { window.removeEventListener(familyNotificationsChangedEvent,listener); }
  });
});
describe("bounded notification target readers", () => {
  const result=()=>familyResult({student_id:id(2),assessment_id:id(4),metadata:resultMetadata({assessment_id:id(4)})});
  const leave=()=>({id:id(3),school_id:"school-a",student_id:id(2),student_name:"QA child",admission_no:"QA-1",academic_year_id:"year-a",academic_year_name:"2026-27",class_name:"6",section_name:"A",start_date:"2026-11-06",end_date:"2026-11-06",reason:"Family visit",status:"approved",requester_id:"parent",requester_name:"QA parent",created_at:stamp,reviewed_by:"principal",reviewer_name:"QA principal",review_note:"Approved",reviewed_at:stamp,total_count:1});
  it("loads one exact result even outside the first history page", async()=>{
    const saved=client(result());expect(await getFamilyNotificationResult(saved.client,"student",id(2),"school-a",id(4))).toEqual(result());
    expect(saved.rpc).toHaveBeenCalledWith("get_family_notification_result",{p_role:"student",p_student_id:id(2),p_assessment_id:id(4)});
    expect(await getFamilyNotificationResult(client(null).client,"parent",id(2),"school-a",id(4))).toBeNull();
  });
  it("checks result child, assessment and school instead of trusting a URL",async()=>{
    for(const patch of [{student_id:id(9)},{assessment_id:id(9)},{metadata:resultMetadata({assessment_id:id(4),school_id:"school-b"})}]) await expect(getFamilyNotificationResult(client({...result(),...patch}).client,"parent",id(2),"school-a",id(4))).rejects.toThrow();
    const saved=client(result());await expect(getFamilyNotificationResult(saved.client,"parent",id(2),"school-a","bad")).rejects.toThrow("invalid");expect(saved.rpc).not.toHaveBeenCalled();
  });
  it("loads one exact reviewed leave and rejects pending or foreign rows",async()=>{
    expect(await getFamilyNotificationLeave(client(leave()).client,"parent",id(2),"school-a",id(3))).toEqual(leave());
    expect(await getFamilyNotificationLeave(client(null).client,"student",id(2),"school-a",id(3))).toBeNull();
    for(const patch of [{id:id(9)},{student_id:id(9)},{school_id:"school-b"},{status:"pending"}]) await expect(getFamilyNotificationLeave(client({...leave(),...patch}).client,"parent",id(2),"school-a",id(3))).rejects.toThrow();
  });
});
