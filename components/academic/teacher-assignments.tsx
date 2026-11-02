"use client";
import { useEffect, useState } from 'react';
import { Pencil, Plus, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { getCurrentTeacherAssignments, getCurrentTeacherId, TeachingAssignment } from '@/lib/academic';

type FormState = { class_id:string; section_id:string; subject_id:string; academic_year_id:string; is_class_teacher:boolean };
const emptyForm: FormState = { class_id:'', section_id:'', subject_id:'', academic_year_id:'', is_class_teacher:false };

export function TeacherAssignments() {
  const [items,setItems]=useState<TeachingAssignment[]>([]);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState('');
  const [form,setForm]=useState<FormState>(emptyForm);
  const [editingId,setEditingId]=useState<string|null>(null);
  const [options,setOptions]=useState<any>({classes:[],sections:[],subjects:[],years:[]});

  async function load(){
    setLoading(true);
    try { setItems(await getCurrentTeacherAssignments()); }
    catch(e:any){ setMessage(e.message ?? 'Could not load assignments.'); }
    finally { setLoading(false); }
  }

  useEffect(()=>{
    load();
    (async()=>{
      const s=createClient();
      const [c,se,su,y]=await Promise.all([
        s.from('classes').select('id,name').order('name'),
        s.from('sections').select('id,name').order('name'),
        s.from('subjects').select('id,name').order('name'),
        s.from('academic_years').select('id,name').order('start_date',{ascending:false}),
      ]);
      setOptions({classes:c.data??[],sections:se.data??[],subjects:su.data??[],years:y.data??[]});
    })();
  },[]);

  function edit(a: TeachingAssignment){
    setEditingId(a.id);
    setForm({class_id:a.class_id,section_id:a.section_id,subject_id:a.subject_id,academic_year_id:a.academic_year_id,is_class_teacher:a.is_class_teacher});
    setMessage('');
  }

  function reset(){setEditingId(null);setForm(emptyForm);}

  async function save(){
    if(!form.class_id||!form.section_id||!form.subject_id||!form.academic_year_id){setMessage('Class, section, subject and academic year are required.');return;}
    setSaving(true);setMessage('');
    try {
      const s=createClient();
      const teacherId=await getCurrentTeacherId();
      if(!teacherId){setMessage('Teacher profile not found.');return;}
      if(editingId){
        const {error}=await s.from('teacher_subject_assignments').update({...form}).eq('id',editingId).eq('teacher_id',teacherId);
        if(error)throw error;
        setMessage('Teaching assignment updated.');
      } else {
        const {error}=await s.from('teacher_subject_assignments').insert({...form,teacher_id:teacherId});
        if(error)throw error;
        setMessage('Teaching assignment added.');
      }
      reset(); await load();
    } catch(e:any){setMessage(e.message??'Could not save assignment.');}
    finally{setSaving(false);}
  }

  async function remove(id:string){
    if(id.startsWith('demo-')){setMessage('Demo assignment cannot be deleted.');return;}
    if(!confirm('Remove this teaching assignment?')) return;
    const s=createClient();
    const teacherId=await getCurrentTeacherId();
    if(!teacherId){setMessage('Teacher profile not found.');return;}
    const {error}=await s.from('teacher_subject_assignments').delete().eq('id',id).eq('teacher_id',teacherId);
    if(error)setMessage(error.message); else {setMessage('Assignment removed.');await load();}
  }

  const fields:[keyof FormState,string,string][]=[['class_id','Class','classes'],['section_id','Section','sections'],['subject_id','Subject','subjects'],['academic_year_id','Academic Year','years']];

  return <div className="space-y-6">
    <div><div className="text-xs font-semibold uppercase tracking-widest text-blue-600">Teacher Workspace</div><h1 className="mt-1 text-3xl font-black">Manage My Teaching Assignments</h1><p className="mt-1 text-sm muted">Har teacher apni classes, sections aur subjects khud manage karega. Admin approval required nahi hai.</p></div>
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2 font-bold"><Plus size={18}/>{editingId?'Edit Teaching Assignment':'Add Teaching Assignment'}</div>{editingId&&<button onClick={reset} className="inline-flex items-center gap-1 text-sm muted"><X size={16}/>Cancel</button>}</div>
      <div className="grid gap-4 md:grid-cols-4">
        {fields.map(([key,label,source])=><label key={key} className="block"><span className="mb-2 block text-xs font-semibold">{label}</span><select value={String(form[key])} onChange={e=>setForm({...form,[key]:e.target.value} as FormState)} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-sm"><option value="">Select {label}</option>{options[source].map((o:any)=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}
      </div>
      <label className="mt-4 flex items-center gap-3 text-sm"><input type="checkbox" checked={form.is_class_teacher} onChange={e=>setForm({...form,is_class_teacher:e.target.checked})}/> I am the Class Teacher for this class/section</label>
      <button disabled={saving} onClick={save} className="mt-4 inline-flex items-center gap-2 rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50">{editingId?<Save size={16}/>:<Plus size={16}/>} {saving?'Saving...':editingId?'Update Assignment':'Add Assignment'}</button>
      {message&&<p className="mt-3 text-sm text-blue-600">{message}</p>}
    </div>
    <div className="card overflow-hidden"><div className="border-b border-[var(--border)] p-5"><div className="font-bold">My Teaching Assignments</div><div className="mt-1 text-xs muted">Only this teacher's assignments are shown here.</div></div>
      {loading?<div className="p-6 text-sm muted">Loading...</div>:items.length===0?<div className="p-6 text-sm muted">No teaching assignments yet.</div>:<div className="grid gap-4 p-5 md:grid-cols-2">{items.map(a=><div key={a.id} className="rounded-2xl border border-[var(--border)] p-5"><div className="flex items-start justify-between"><div><div className="text-xs uppercase tracking-wide muted">{a.class_name} / {a.section_name}</div><div className="mt-2 text-lg font-bold">{a.subject_name}</div></div>{a.is_class_teacher&&<span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600">Class Teacher</span>}</div><div className="mt-4 flex items-center justify-between"><span className="flex items-center gap-2 text-xs muted"><ShieldCheck size={14}/>Self-managed</span><div className="flex gap-1"><button onClick={()=>edit(a)} className="rounded-lg p-2 muted hover:bg-[var(--surface-2)]" title="Edit"><Pencil size={16}/></button><button onClick={()=>remove(a.id)} className="rounded-lg p-2 text-red-500 hover:bg-red-500/10" title="Delete"><Trash2 size={16}/></button></div></div></div>)}</div>}
    </div>
  </div>
}
