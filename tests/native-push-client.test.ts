import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { loadNativePushSettings, revokeNativePushDevice, saveNativePushPreferences, type NativePushPreferences } from "@/lib/notifications/native-push";
const deviceId="31000000-0000-4000-8000-000000000001",stamp="2026-11-06T10:00:00.123456+00:00";
const preferences: NativePushPreferences={enabled:false,absence:true,result_published:true,leave_decision:true,version:0};
const device={id:deviceId,platform:"android",label:"QA phone",created_at:stamp,last_seen_at:stamp,revoked_at:null};
const settings=(patch:Record<string,unknown>={})=>({preferences,devices:[device],...patch});
function client(data:unknown,error:{code?:string}|null=null){
 const abortSignal=vi.fn().mockResolvedValue({data,error});const rpc=vi.fn().mockReturnValue(Object.assign(Promise.resolve({data,error}),{abortSignal}));
 return {rpc,abortSignal,client:{rpc} as unknown as SupabaseClient};
}
describe("native push own-settings boundary",()=>{
 it("requests the exact family role, binds cancellation, and exposes only redacted fields",async()=>{
  const saved=client({...settings(),extra:"discard",devices:[{...device,unknown:"discard"}]});const signal=new AbortController().signal;
  expect(await loadNativePushSettings(saved.client,"parent",signal)).toEqual(settings());
  expect(saved.rpc).toHaveBeenCalledWith("get_my_family_push_settings",{p_role:"parent"});expect(saved.abortSignal).toHaveBeenCalledWith(signal);
 });
 it.each([
  {preferences:{...preferences,enabled:"false"}},{preferences:{...preferences,version:-1}},{preferences:{...preferences,version:Number.MAX_SAFE_INTEGER+1}},
  {devices:[device,device]},{devices:[{...device,id:"foreign"}]},{devices:[{...device,platform:"web"}]},{devices:[{...device,label:" "}]},
  {devices:[{...device,created_at:"invalid"}]},{devices:[{...device,revoked_at:"invalid"}]},{devices:[{...device,token:"private"}]},
  {devices:[{...device,installation_secret:"private"}]},{session_id:"private"},
 ])("rejects malformed or accidentally sensitive responses %j",async(patch)=>{
  await expect(loadNativePushSettings(client(settings(patch)).client,"student")).rejects.toThrow("could not be verified");
 });
 it("counts device labels in Unicode codepoints like PostgreSQL",async()=>{
  const label="📱".repeat(80);expect((await loadNativePushSettings(client(settings({devices:[{...device,label}]})).client,"parent")).devices[0].label).toBe(label);
  await expect(loadNativePushSettings(client(settings({devices:[{...device,label:label+"📱"}]})).client,"parent")).rejects.toThrow();
 });
 it("rejects oversized histories and invalid roles before exposing data",async()=>{
  await expect(loadNativePushSettings(client(settings({devices:Array.from({length:51},(_,i)=>({...device,id:`31000000-0000-4000-8000-${String(i).padStart(12,"0")}`}))})).client,"parent")).rejects.toThrow();
  const saved=client(settings());await expect(loadNativePushSettings(saved.client,"admin" as "parent")).rejects.toThrow("valid family");expect(saved.rpc).not.toHaveBeenCalled();
 });
 it("sends optimistic preference version and checks the confirmed desired state",async()=>{
  const next={...preferences,enabled:true},saved=client(settings({preferences:{...next,version:1}}));
  expect((await saveNativePushPreferences(saved.client,"parent",next)).preferences.version).toBe(1);
  expect(saved.rpc).toHaveBeenCalledWith("set_my_family_push_preferences",{p_role:"parent",p_enabled:true,p_absence:true,p_result_published:true,p_leave_decision:true,p_expected_version:0});
  await expect(saveNativePushPreferences(client(settings()).client,"parent",next)).rejects.toThrow("could not be verified");
  await expect(saveNativePushPreferences(client(settings({preferences:{...next,version:0}})).client,"parent",{...next,version:2})).rejects.toThrow();
 });
 it("supports identical lost-ack retry returning a later confirmed version",async()=>{
  const saved=client(settings({preferences:{...preferences,version:4}}));
  expect((await saveNativePushPreferences(saved.client,"student",preferences)).preferences.version).toBe(4);
 });
 it("validates preferences and device identifiers before invoking a write",async()=>{
  const saved=client(settings());await expect(saveNativePushPreferences(saved.client,"student",{...preferences,enabled:undefined as unknown as boolean})).rejects.toThrow();
  await expect(revokeNativePushDevice(saved.client,"student","bad")).rejects.toThrow("valid mobile device");expect(saved.rpc).not.toHaveBeenCalled();
 });
 it("requires a boolean revoke acknowledgement and permits already-gone false without claiming a mutation",async()=>{
  const saved=client(true);expect(await revokeNativePushDevice(saved.client,"parent",deviceId)).toBe(true);
  expect(saved.rpc).toHaveBeenCalledWith("revoke_my_family_push_device",{p_role:"parent",p_device_id:deviceId});
  expect(await revokeNativePushDevice(client(false).client,"parent",deviceId)).toBe(false);
  await expect(revokeNativePushDevice(client(null).client,"parent",deviceId)).rejects.toThrow("could not be verified");
 });
 it.each([["PT409","changed in another session"],["42501","access changed"],["PGRST202","latest school update"],["500","could not be confirmed"]])("explains %s without leaking server/provider messages",async(code,message)=>{
  await expect(loadNativePushSettings(client(null,{code}).client,"parent")).rejects.toThrow(message);
 });
});
