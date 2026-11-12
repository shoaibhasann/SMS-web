// @vitest-environment node
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({createClient:vi.fn(),rpc:vi.fn(),fcmConfiguration:vi.fn(),fcmAccessToken:vi.fn(),send:vi.fn()}));
vi.mock("@supabase/supabase-js",()=>({createClient:mocks.createClient}));
vi.mock("@/lib/notifications/fcm",()=>({fcmConfiguration:mocks.fcmConfiguration,fcmAccessToken:mocks.fcmAccessToken,sendFcmNotification:mocks.send}));
import { POST } from "@/app/api/push/dispatch/route";
import { GET as CRON } from "@/app/api/push/cron/route";
import { GET } from "@/app/api/push/status/route";
const id=(n:number)=>`35000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const secret="private-fixture-dispatch-secret-1234567890";
const cronSecret = "private-fixture-cron-secret-1234567890";
const fid="c"+"1".repeat(21);
const config={projectId:"sms-fixture",email:"private@service.test",privateKey:"private-key"};
const request=(auth=`Bearer ${secret}`)=>new Request("https://school.test/api/push/dispatch",{method:"POST",headers:{Authorization:auth}});
const cronRequest = (auth = `Bearer ${cronSecret}`, method = "GET") =>
 new Request("https://school.test/api/push/cron", { method, headers: { Authorization: auth } });
const prepared=(n=1)=>({job_id:id(n),lease_id:id(n+10),device_fid:fid,platform:"android",kind:"leave_decision",event_id:id(n+20),recipient_role:"parent",expires_at:new Date(Date.now()+86400000).toISOString()});
function response(data:unknown,error:unknown=null){return {abortSignal:vi.fn().mockResolvedValue({data,error})};}
beforeEach(()=>{
 for(const [key,value] of Object.entries({NATIVE_PUSH_ENABLED:"true",PUSH_DISPATCH_SECRET:secret,SUPABASE_SERVICE_ROLE_KEY:"private-service-key",NEXT_PUBLIC_SUPABASE_URL:"https://fixture.supabase.co"}))vi.stubEnv(key,value);
 mocks.fcmConfiguration.mockReturnValue(config);mocks.fcmAccessToken.mockResolvedValue("private-access");mocks.send.mockResolvedValue({outcome:"accepted",code:"FCM_ACCEPTED",providerId:"projects/sms-fixture/messages/123"});
 mocks.createClient.mockReturnValue({rpc:mocks.rpc});mocks.rpc.mockImplementation((name:string,args:Record<string,unknown>)=>response(name==="claim_family_push_jobs"?[{id:id(1),lease_id:id(11)}]:name==="prepare_family_push_job"?prepared(Number(String(args.p_job_id).slice(-1))):true));
});
afterEach(()=>{vi.unstubAllEnvs();});
describe("protected native push dispatch",()=>{
 it.each(["", "Bearer wrong", "Bearer public-user-jwt", `bearer ${secret}`])("denies invalid authorization before provider/DB calls",async auth=>{expect((await POST(request(auth))).status).toBe(401);expect(mocks.fcmAccessToken).not.toHaveBeenCalled();expect(mocks.createClient).not.toHaveBeenCalled();});
 it("keeps missing or disabled config unavailable and reports only administrative status",async()=>{
  vi.stubEnv("NATIVE_PUSH_ENABLED","false");expect(await (await GET()).json()).toEqual({configured:false,nativeAppRequired:true});expect((await POST(request())).status).toBe(503);expect(mocks.fcmAccessToken).not.toHaveBeenCalled();
  vi.stubEnv("NATIVE_PUSH_ENABLED","true");mocks.fcmConfiguration.mockReturnValue(null);expect((await POST(request())).status).toBe(503);
 });
 it.each(["http://fixture.supabase.co","https://user:pass@fixture.supabase.co","https://fixture.supabase.co/path","https://fixture.supabase.co/?secret=1"])("rejects unsafe database target %s",async url=>{vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL",url);expect((await POST(request())).status).toBe(503);expect(mocks.createClient).not.toHaveBeenCalled();});
 it("never claims a job when provider authentication fails",async()=>{mocks.fcmAccessToken.mockRejectedValue(new Error("private-provider-key"));const res=await POST(request());expect(res.status).toBe(503);expect(mocks.rpc).not.toHaveBeenCalled();expect(JSON.stringify(await res.json())).not.toContain("private-provider-key");});
 it("requires the dedicated cron bearer before entering the worker", async () => {
  vi.stubEnv("CRON_SECRET", undefined);
  expect((await CRON(cronRequest())).status).toBe(401);
  vi.stubEnv("CRON_SECRET", cronSecret);
  expect((await CRON(cronRequest(`Bearer ${secret}`))).status).toBe(401);
  expect((await POST(request(`Bearer ${cronSecret}`))).status).toBe(401);
  expect((await CRON(cronRequest(undefined, "HEAD"))).status).toBe(405);
  vi.stubEnv("NATIVE_PUSH_ENABLED", "false");
  expect((await CRON(cronRequest())).status).toBe(503);
  expect(mocks.fcmAccessToken).not.toHaveBeenCalled();
  expect(mocks.createClient).not.toHaveBeenCalled();
 });
 it("dispatches the shared queue once through an authenticated cron GET", async () => {
  vi.stubEnv("CRON_SECRET", cronSecret);
  const response = await CRON(cronRequest());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ claimed: 1, accepted: 1 });
  expect(mocks.send).toHaveBeenCalledOnce();
 });
 it("authenticates, claims bounded jobs, rechecks immediately before each send and records acceptance",async()=>{
  const res=await POST(request());expect(res.status).toBe(200);expect(await res.json()).toEqual({claimed:1,accepted:1,retry:0,invalid_token:0,failed:0,suppressed:0,unconfirmed:0});expect(res.headers.get("cache-control")).toBe("no-store");
  expect(mocks.createClient).toHaveBeenCalledWith("https://fixture.supabase.co","private-service-key",{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  expect(mocks.rpc.mock.calls.map(([name])=>name)).toEqual(["claim_family_push_jobs","prepare_family_push_job","finish_family_push_job"]);
  expect(mocks.rpc.mock.calls[0][1]).toMatchObject({p_limit:20,p_batch_id:expect.stringMatching(/^[0-9a-f-]{36}$/)});expect(mocks.send).toHaveBeenCalledWith(config,"private-access",{device_fid:fid,platform:"android",kind:"leave_decision",expires_at:expect.any(String)});
 });
 it.each(["exam_schedule","homework_assigned","announcement","fee_due","fee_payment"])("sends %s through the neutral provider route",async kind=>{
  mocks.rpc.mockImplementation((name:string)=>response(name==="claim_family_push_jobs"?[{id:id(1),lease_id:id(11)}]:name==="prepare_family_push_job"?{...prepared(),kind}:true));
  const res=await POST(request());expect(res.status).toBe(200);expect(await res.json()).toMatchObject({accepted:1});
  expect(mocks.send).toHaveBeenCalledWith(config,"private-access",{device_fid:fid,platform:"android",kind,expires_at:expect.any(String)});
 });
 it("does not send a job suppressed after revocation/preferences/session change",async()=>{mocks.rpc.mockImplementation((name:string)=>response(name==="claim_family_push_jobs"?[{id:id(1),lease_id:id(11)}]:null));const res=await POST(request());expect((await res.json()).suppressed).toBe(1);expect(mocks.send).not.toHaveBeenCalled();});
 it.each([{job_id:id(9)},{lease_id:id(9)},{device_fid:"not-fid"},{recipient_role:"admin"},{kind:"fee"},{platform:"web"},{expires_at:"not-date"},{event_id:"bad"}])("fails closed for malformed prepared jobs %j",async patch=>{mocks.rpc.mockImplementation((name:string)=>response(name==="claim_family_push_jobs"?[{id:id(1),lease_id:id(11)}]:{...prepared(),...patch}));const res=await POST(request());expect(res.status).toBe(503);expect((await res.json()).unconfirmed).toBe(1);expect(mocks.send).not.toHaveBeenCalled();});
 it("rejects duplicate or oversized claims before sending",async()=>{const job={id:id(1),lease_id:id(11)};for(const jobs of [[job,job],Array.from({length:21},(_,n)=>({id:id(n+1),lease_id:id(n+11)}))]){mocks.rpc.mockReturnValue(response(jobs));expect((await POST(request())).status).toBe(503);expect(mocks.send).not.toHaveBeenCalled();}});
 it.each(["retry","invalid_token","failed"] as const)("records %s separately from provider acceptance and inbox reads",async outcome=>{mocks.send.mockResolvedValue({outcome,code:"SAFE_CODE",retryAfterSeconds:120});const res=await POST(request());const body=await res.json();expect(body[outcome]).toBe(1);expect(body.accepted).toBe(0);expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({p_outcome:outcome,p_code:"SAFE_CODE",p_retry_after_seconds:120});expect(mocks.rpc.mock.calls.some(([name])=>String(name).includes("read"))).toBe(false);});
 it("counts a retry the server cancelled as no longer eligible as suppressed, not retry",async()=>{
  mocks.send.mockResolvedValue({outcome:"retry",code:"PROVIDER_UNAVAILABLE",retryAfterSeconds:120});
  mocks.rpc.mockImplementation((name:string)=>response(name==="claim_family_push_jobs"?[{id:id(1),lease_id:id(11)}]:name==="prepare_family_push_job"?prepared():null));
  const res=await POST(request());expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({claimed:1,retry:0,suppressed:1,unconfirmed:0});
 });
 it("does not claim success for a stale lease or lost finish acknowledgement",async()=>{mocks.rpc.mockImplementation((name:string)=>response(name==="claim_family_push_jobs"?[{id:id(1),lease_id:id(11)}]:name==="prepare_family_push_job"?prepared():false));const res=await POST(request());expect(res.status).toBe(503);expect(await res.json()).toMatchObject({accepted:0,unconfirmed:1});expect(mocks.send).toHaveBeenCalledOnce();});
 it("continues independent jobs after a failed preparation without leaking lease IDs or tokens",async()=>{
  mocks.rpc.mockImplementation((name:string,args:Record<string,unknown>)=>response(name==="claim_family_push_jobs"?[{id:id(1),lease_id:id(11)},{id:id(2),lease_id:id(12)}]:name==="prepare_family_push_job"?prepared(args.p_job_id===id(1)?1:2):true,name==="prepare_family_push_job"&&args.p_job_id===id(1)?{message:"private-rpc-detail"}:null));
  const res=await POST(request());const text=await res.text();expect(res.status).toBe(503);expect(JSON.parse(text)).toMatchObject({accepted:1,unconfirmed:1});expect(text).not.toMatch(/private|35000000|c123456/);
 });
});


it("bounds a full20-job batch to five simultaneous sends",async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let active=0,peak=0;
 mocks.rpc.mockImplementation((name:string,args:Record<string,unknown>)=>{
  if(name==="claim_family_push_jobs")return response(mocks.rpc.mock.calls.filter(([call])=>call===name).length===1?Array.from({length:20},(_,i)=>({id:id(i+1),lease_id:id(i+101)})):[]);
  if(name==="prepare_family_push_job")return response({...prepared(),job_id:args.p_job_id,lease_id:args.p_lease_id});
  return response(true);
 });
 mocks.send.mockImplementation(async()=>{active++;peak=Math.max(peak,active);await gate;active--;return {outcome:"accepted",code:"FCM_ACCEPTED",providerId:"projects/sms-fixture/messages/123"};});
 const pending=POST(request());await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(5));expect(peak).toBe(5);release();
 const res=await pending;expect(res.status).toBe(200);expect((await res.json()).accepted).toBe(20);expect(peak).toBe(5);
 expect(mocks.rpc.mock.calls.filter(([name])=>name==="claim_family_push_jobs")).toHaveLength(2);
});

describe("draining a backlog within one scheduled run",()=>{
 const full=(start:number,length=20)=>Array.from({length},(_,i)=>({id:id(start+i),lease_id:id(start+i+500)}));
 const queue=(batches:{id:string;lease_id:string}[][])=>{
  mocks.rpc.mockImplementation((name:string,args:Record<string,unknown>)=>{
   if(name==="claim_family_push_jobs")return response(batches.shift()??[]);
   if(name==="prepare_family_push_job")return response({...prepared(),job_id:args.p_job_id,lease_id:args.p_lease_id});
   return response(true);
  });
 };
 const claims=()=>mocks.rpc.mock.calls.filter(([name])=>name==="claim_family_push_jobs");
 it("keeps claiming fresh 20-job batches until a short batch shows the queue is drained",async()=>{
  queue([full(1),full(21),full(41,5)]);
  const res=await POST(request());expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({claimed:45,accepted:45,unconfirmed:0});
  expect(claims()).toHaveLength(3);
  expect(new Set(claims().map(([,args])=>args.p_batch_id)).size).toBe(3);
  expect(claims().every(([,args])=>args.p_limit===20)).toBe(true);
 });
 it("stops claiming after an unconfirmed job",async()=>{
  queue([full(1),full(21)]);
  mocks.send.mockResolvedValueOnce({outcome:"accepted",code:"FCM_ACCEPTED",providerId:"projects/sms-fixture/messages/1"});
  mocks.rpc.mockImplementation((name:string,args:Record<string,unknown>)=>{
   if(name==="claim_family_push_jobs")return response(claims().length===1?full(1):full(21));
   if(name==="prepare_family_push_job")return response({...prepared(),job_id:args.p_job_id,lease_id:args.p_lease_id});
   return response(args.p_job_id!==id(1));
  });
  const res=await POST(request());expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({claimed:20,unconfirmed:1});
  expect(claims()).toHaveLength(1);
 });
 it("does not start another claim after the claim window",async()=>{
  const now=Date.now();let calls=0;
  const clock=vi.spyOn(Date,"now").mockImplementation(()=>now+(calls++>0?26_000:0));
  queue([full(1),full(21)]);
  try{
   const res=await POST(request());expect(res.status).toBe(200);
   expect(await res.json()).toMatchObject({claimed:20,accepted:20});
   expect(claims()).toHaveLength(1);
  }finally{clock.mockRestore();}
 });
});
