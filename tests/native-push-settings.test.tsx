import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativePushSettings } from "@/components/notifications/native-push-settings";
import type { NativePushPreferences, NativePushRole, NativePushSettings as Settings } from "@/lib/notifications/native-push";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),listener:(()=>{}) as (event:string,session:{user:{id:string}}|null)=>void}));
vi.mock("@/lib/supabase/client",()=>({createClient:()=>({rpc:mocks.rpc,auth:{onAuthStateChange:(listener:typeof mocks.listener)=>{mocks.listener=listener;return {data:{subscription:{unsubscribe:vi.fn()}}};}}})}));
const deviceId="31000000-0000-4000-8000-000000000001",stamp="2026-11-06T10:00:00Z";
const initial:NativePushPreferences={enabled:false,absence:true,result_published:true,leave_decision:true,version:0};
const device={id:deviceId,platform:"android" as const,label:"QA Android",created_at:stamp,last_seen_at:stamp,revoked_at:null};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function store(parent:Settings={preferences:{...initial},devices:[]},student:Settings={preferences:{...initial},devices:[]}){
 const data={parent:structuredClone(parent),student:structuredClone(student)};
 let failSave:string|null=null,loadWait:Promise<void>|undefined,saveWait:Promise<void>|undefined,failRevoke=false;
 mocks.rpc.mockImplementation((name:string,args:Record<string,unknown>)=>{
  const run=async()=>{
   const current=data[args.p_role as NativePushRole];
   if(name==="get_my_family_push_settings"){const snapshot=structuredClone(current);await loadWait;return {data:snapshot,error:null};}
   if(name==="set_my_family_push_preferences"){
    await saveWait;if(failSave)return {data:null,error:{code:failSave}};
    current.preferences={enabled:args.p_enabled as boolean,absence:args.p_absence as boolean,result_published:args.p_result_published as boolean,leave_decision:args.p_leave_decision as boolean,version:current.preferences.version+1};
    return {data:structuredClone(current),error:null};
   }
   if(name==="revoke_my_family_push_device"){
    if(failRevoke)return {data:false,error:null};
    current.devices=current.devices.map(row=>row.id===args.p_device_id?{...row,revoked_at:stamp}:row);return {data:true,error:null};
   }
   throw Error(`Unexpected RPC ${name}`);
  };
  const reply=run();return Object.assign(reply,{abortSignal:()=>reply});
 });
 return {data,failSave:(code:string)=>{failSave=code;},loadWait:(promise:Promise<void>)=>{loadWait=promise;},saveWait:(promise:Promise<void>)=>{saveWait=promise;},failRevoke:()=>{failRevoke=true;}};
}
const allow=()=>screen.getByRole("checkbox",{name:/^Allow mobile push notifications/});
beforeEach(()=>{mocks.rpc.mockReset();});
describe("native app push settings",()=>{
 it("shows opt-out defaults and honest empty devices without browser/native registration controls",async()=>{
  store();render(<NativePushSettings userId="guardian-a" roles={["parent"]}/>);
  expect(await screen.findByText(/No mobile devices linked/)).toBeInTheDocument();expect(allow()).not.toBeChecked();
  expect(screen.getByText(/mobile push includes new and updated exam schedules/)).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"Save push preferences"})).toBeDisabled();
  expect(mocks.rpc.mock.calls.every(([name])=>name==="get_my_family_push_settings")).toBe(true);
  expect(screen.queryByRole("button",{name:/enable notifications|register|test push/i})).not.toBeInTheDocument();
 });
 it("saves a reviewed preference version and persists the server state after reopening",async()=>{
  const saved=store();const user=userEvent.setup();const view=render(<NativePushSettings userId="guardian-a" roles={["parent"]}/>);
  await screen.findByRole("form",{name:"Mobile push preferences"});await user.click(allow());await user.click(screen.getByRole("checkbox",{name:"Published results"}));
  await user.click(screen.getByRole("button",{name:"Save push preferences"}));expect(await screen.findByRole("status")).toHaveTextContent("preferences saved");
  expect(saved.data.parent.preferences).toMatchObject({enabled:true,result_published:false,version:1});
  const call=mocks.rpc.mock.calls.find(([name])=>name==="set_my_family_push_preferences");expect(call?.[1]).toMatchObject({p_role:"parent",p_expected_version:0,p_enabled:true,p_result_published:false});
  view.unmount();render(<NativePushSettings userId="guardian-a" roles={["parent"]}/>);await screen.findByRole("form",{name:"Mobile push preferences"});expect(allow()).toBeChecked();expect(screen.getByRole("checkbox",{name:"Published results"})).not.toBeChecked();
 });
 it("keeps a stale draft until explicit refresh and asks before discarding unsaved changes",async()=>{
  const saved=store();saved.failSave("PT409");const user=userEvent.setup();render(<NativePushSettings userId="guardian-a" roles={["parent"]}/>);
  await screen.findByRole("form",{name:"Mobile push preferences"});await user.click(allow());await user.click(screen.getByRole("button",{name:"Save push preferences"}));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed in another session");expect(allow()).toBeChecked();expect(saved.data.parent.preferences.enabled).toBe(false);
  const confirm=vi.spyOn(window,"confirm").mockReturnValue(false);
  try{await user.click(screen.getByRole("button",{name:"Refresh push settings"}));expect(allow()).toBeChecked();confirm.mockReturnValue(true);await user.click(screen.getByRole("button",{name:"Refresh push settings"}));await waitFor(()=>expect(allow()).not.toBeChecked());}finally{confirm.mockRestore();}
 });
 it("requires explicit device revocation, refetches redacted state and preserves an unsaved preference draft",async()=>{
  const saved=store({preferences:{...initial},devices:[device]});const user=userEvent.setup();render(<NativePushSettings userId="guardian-a" roles={["parent"]}/>);
  await screen.findByText("QA Android");await user.click(allow());await user.click(screen.getByRole("button",{name:"Revoke device: QA Android"}));
  expect(mocks.rpc.mock.calls.some(([name])=>name==="revoke_my_family_push_device")).toBe(false);
  expect(screen.getByRole("button",{name:"Confirm revoke device"})).toHaveFocus();
  await user.click(screen.getByRole("button",{name:"Cancel revocation"}));expect(screen.getByRole("button",{name:"Revoke device: QA Android"})).toHaveFocus();
  await user.click(screen.getByRole("button",{name:"Revoke device: QA Android"}));await user.click(screen.getByRole("button",{name:"Confirm revoke device"}));
  expect(await screen.findByRole("status")).toHaveTextContent("Device revoked");expect(saved.data.parent.devices[0].revoked_at).toBe(stamp);expect(allow()).toBeChecked();
  expect(screen.getByText("Android · Revoked")).toBeInTheDocument();expect(screen.queryByRole("button",{name:"Revoke device: QA Android"})).not.toBeInTheDocument();
 });
 it("does not report a foreign or missing device as successfully revoked",async()=>{
  const saved=store({preferences:{...initial},devices:[device]});saved.failRevoke();const user=userEvent.setup();render(<NativePushSettings userId="guardian-a" roles={["parent"]}/>);
  await user.click(await screen.findByRole("button",{name:"Revoke device: QA Android"}));await user.click(screen.getByRole("button",{name:"Confirm revoke device"}));
  expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");expect(saved.data.parent.devices[0].revoked_at).toBeNull();
 });
 it("switches only between supplied verified family contexts and clears old rows before the next role resolves",async()=>{
  const saved=store({preferences:{...initial,enabled:true},devices:[device]});const user=userEvent.setup();render(<NativePushSettings userId="mixed-a" roles={["parent","student"]}/>);
  await screen.findByText("QA Android");const pending=deferred<void>();saved.loadWait(pending.promise);
  await user.selectOptions(screen.getByLabelText("Notification account view"),"student");expect(screen.queryByText("QA Android")).not.toBeInTheDocument();expect(screen.getByText("Loading mobile notification settings…")).toBeInTheDocument();
  await act(async()=>pending.resolve());await screen.findByRole("form",{name:"Mobile push preferences"});expect(allow()).not.toBeChecked();
  expect(mocks.rpc).toHaveBeenLastCalledWith("get_my_family_push_settings",{p_role:"student"});
 });
 it("offers Guardian absence alerts but only result and leave options in the Student view",async()=>{
  store();const user=userEvent.setup();render(<NativePushSettings userId="mixed-a" roles={["parent","student"]}/>);
  expect(await screen.findByRole("checkbox",{name:"Absent attendance"})).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Notification account view"),"student");
  expect(await screen.findByText("Student app alerts cover exam schedules, published results and leave decisions.")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox",{name:"Absent attendance"})).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox",{name:"Published results"})).toBeInTheDocument();expect(screen.getByRole("checkbox",{name:"Leave decisions"})).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Notification account view"),"parent");expect(await screen.findByRole("checkbox",{name:"Absent attendance"})).toBeInTheDocument();
 });
 it("ignores delayed old-account reads after a role/user-key remount",async()=>{
  const saved=store({preferences:{...initial},devices:[device]});const pending=deferred<void>();saved.loadWait(pending.promise);
  const view=render(<NativePushSettings userId="guardian-a" roles={["parent"]}/>);
  saved.loadWait(Promise.resolve());view.rerender(<NativePushSettings userId="student-b" roles={["student"]}/>);
  await screen.findByText(/No mobile devices linked/);await act(async()=>pending.resolve());expect(screen.queryByText("QA Android")).not.toBeInTheDocument();
 });
 it("aborts a pending write and hides the old account state after sign-out",async()=>{
  const saved=store();const user=userEvent.setup();const pending=deferred<void>();saved.saveWait(pending.promise);render(<NativePushSettings userId="guardian-a" roles={["parent"]}/>);
  await screen.findByRole("form",{name:"Mobile push preferences"});await user.click(allow());await user.click(screen.getByRole("button",{name:"Save push preferences"}));
  act(()=>mocks.listener("SIGNED_OUT",null));expect(await screen.findByRole("alert")).toHaveTextContent("sign-in changed");expect(screen.queryByRole("form",{name:"Mobile push preferences"})).not.toBeInTheDocument();
  await act(async()=>pending.resolve());expect(screen.queryByText(/preferences saved/)).not.toBeInTheDocument();
 });
 it("prevents parallel saves and locks context controls while the acknowledged request is pending",async()=>{
  const saved=store();const pending=deferred<void>();saved.saveWait(pending.promise);render(<NativePushSettings userId="mixed-a" roles={["parent","student"]}/>);
  const form=await screen.findByRole("form",{name:"Mobile push preferences"});fireEvent.click(allow());fireEvent.submit(form);fireEvent.submit(form);
  expect(mocks.rpc.mock.calls.filter(([name])=>name==="set_my_family_push_preferences")).toHaveLength(1);
  expect(screen.getByLabelText("Notification account view")).toBeDisabled();expect(screen.getByRole("button",{name:"Refresh push settings"})).toBeDisabled();
  await act(async()=>pending.resolve());expect(await screen.findByRole("status")).toHaveTextContent("preferences saved");
 });
 it("renders nothing for an account with no actual family roles",()=>{
  store();const view=render(<NativePushSettings userId="teacher-a" roles={[]}/>);expect(view.container).toBeEmptyDOMElement();expect(mocks.rpc).not.toHaveBeenCalled();
 });
});
