// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const mock=vi.hoisted(()=>({JWT:vi.fn(),getAccessToken:vi.fn()}));
vi.mock("google-auth-library",()=>({JWT:mock.JWT}));
import { fcmAccessToken, fcmConfiguration, sendFcmNotification } from "@/lib/notifications/fcm";
const privateKey=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
const config={projectId:"sms-fixture",email:"sender@sms-fixture.iam.gserviceaccount.com",privateKey};
const fid="c"+"1".repeat(21);
const job=()=>({device_fid:fid,platform:"android" as const,expires_at:new Date(Date.now()+24*3600000).toISOString()});
const fetchMock=vi.fn();
beforeEach(()=>{vi.stubGlobal("fetch",fetchMock);fetchMock.mockReset();mock.JWT.mockImplementation(function(){return {getAccessToken:mock.getAccessToken};});mock.getAccessToken.mockResolvedValue({token:"google-oauth-access"});});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe("FCM server-only provider boundary",()=>{
 it("whitelists service credentials and never honors arbitrary credential URLs",async()=>{
  vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_JSON",JSON.stringify({type:"service_account",project_id:config.projectId,client_email:config.email,private_key:privateKey,token_uri:"https://attacker.test"}));
  expect(fcmConfiguration()).toEqual(config);expect(await fcmAccessToken(config)).toBe("google-oauth-access");
  expect(mock.JWT).toHaveBeenCalledWith({email:config.email,key:privateKey,scopes:["https://www.googleapis.com/auth/firebase.messaging"],transporterOptions:{timeout:5000,retry:false}});
 });
 it.each(["", "{}","not-json",JSON.stringify({type:"user",project_id:"valid",client_email:config.email,private_key:privateKey}),JSON.stringify({type:"service_account",project_id:"../foreign",client_email:config.email,private_key:privateKey}),JSON.stringify({type:"service_account",project_id:config.projectId,client_email:config.email,private_key:"bad-key"})])("fails closed for invalid credentials",value=>{vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_JSON",value);expect(fcmConfiguration()).toBeNull();});
 it("rejects malformed provider Auth tokens",async()=>{mock.getAccessToken.mockResolvedValue({token:"bad\r\nheader"});await expect(fcmAccessToken(config)).rejects.toThrow("unavailable");});
 it("sends FID via fixed HTTPv1 endpoint, generic content and a bounded coalesced Android TTL",async()=>{
  fetchMock.mockResolvedValue(new Response(JSON.stringify({name:"projects/sms-fixture/messages/0:123%abc"})));
  expect(await sendFcmNotification(config,"google-oauth-access",job())).toEqual({outcome:"accepted",code:"FCM_ACCEPTED",providerId:"projects/sms-fixture/messages/0:123%abc"});
  const [url,options]=fetchMock.mock.calls[0];expect(url).toBe("https://fcm.googleapis.com/v1/projects/sms-fixture/messages:send");expect(options.headers.Authorization).toBe("Bearer google-oauth-access");expect(options.redirect).toBe("error");expect(options.signal).toBeInstanceOf(AbortSignal);
  const body=JSON.parse(options.body);expect(body.message.fid).toBe(fid);expect(body.message).not.toHaveProperty("token");expect(body.message.data).toEqual({screen:"notifications"});expect(body.message.notification).toEqual({title:"SMS school update",body:"Open SMS to view your school updates."});expect(body.message.android.ttl).toBe("300s");expect(JSON.stringify(body)).not.toMatch(/student_id|recipient|assessment|leave|marks|reason/);
 });
 it("uses iOS alert expiry/collapse headers without adding private payloads",async()=>{fetchMock.mockResolvedValue(new Response('{"name":"projects/sms-fixture/messages/123"}'));await sendFcmNotification(config,"access",{...job(),platform:"ios"});const body=JSON.parse(fetchMock.mock.calls[0][1].body);expect(body.message.apns.headers["apns-push-type"]).toBe("alert");expect(body.message).not.toHaveProperty("android");});
 it("does not send expired or invalid device references",async()=>{expect(await sendFcmNotification(config,"access",{...job(),expires_at:"2020-01-01T00:00:00Z"})).toEqual({outcome:"failed",code:"EXPIRED"});await expect(sendFcmNotification(config,"access",{...job(),device_fid:"legacy:long-token"})).rejects.toThrow("Invalid");expect(fetchMock).not.toHaveBeenCalled();});
 it.each([429,500,503])("retries %s with Retry-After and avoids trusting error details",async status=>{fetchMock.mockResolvedValue(new Response("private provider text",{status,headers:{"retry-after":"120"}}));expect(await sendFcmNotification(config,"access",job())).toMatchObject({outcome:"retry",retryAfterSeconds:120});});
 it("handles HTTP-date Retry-After and clamps invalid/oversized delays",async()=>{
  for(const [value,expected] of [[new Date(Date.now()+180000).toUTCString(),180],["garbage",60],["999999999",86400]] as const){fetchMock.mockResolvedValue(new Response("",{status:429,headers:{"retry-after":value}}));const result=await sendFcmNotification(config,"access",job());expect(Math.abs((result.retryAfterSeconds??0)-expected)).toBeLessThanOrEqual(1);}
 });
 it("only revokes a confirmed UNREGISTERED destination, never generic400/404 or credential failures",async()=>{
  const response=(status:number,details:unknown)=>new Response(JSON.stringify({error:{details}}),{status});
  fetchMock.mockResolvedValue(response(404,[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError",errorCode:"UNREGISTERED"}]));expect(await sendFcmNotification(config,"access",job())).toEqual({outcome:"invalid_token",code:"UNREGISTERED"});
  for(const status of [400,404]){fetchMock.mockResolvedValue(response(status,[{errorCode:"UNREGISTERED"}]));expect((await sendFcmNotification(config,"access",job())).outcome).toBe("failed");}
 });
 it("leaves network/malformed/oversized/foreign success acknowledgements unconfirmed for retry",async()=>{
  fetchMock.mockRejectedValue(new Error("secret transport debug"));expect((await sendFcmNotification(config,"access",job())).outcome).toBe("retry");
  for(const raw of ['not-json',JSON.stringify({name:"projects/foreign/messages/123"}),"x".repeat(17000)]){fetchMock.mockResolvedValue(new Response(raw));const result=await sendFcmNotification(config,"access",job());expect(result.outcome).toBe("retry");expect(JSON.stringify(result)).not.toContain("secret");}
 });
});

it("backs off provider permission/auth failures without disabling a device",async()=>{for(const status of [401,403]){fetchMock.mockResolvedValue(new Response("{}",{status}));expect(await sendFcmNotification(config,"access",job())).toEqual({outcome:"retry",code:"PROVIDER_AUTH",retryAfterSeconds:3600});}});
