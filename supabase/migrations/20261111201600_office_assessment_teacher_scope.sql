-- An office-created or office-moved assessment must land inside the chosen
-- teacher's actual assignment (a whole-class exam needs a whole-class
-- assignment), so it never becomes an orphan the teacher cannot see or mark.
-- Teacher self-writes and office edits that keep the placement are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function app_private.guard_assessment_write()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
begin
  if current_setting('role',true) not in ('authenticated','anon') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op<>'INSERT' then
    perform app_private.lock_assessment_write_scope(old.teacher_id,old.school_id,old.academic_year_id,old.class_id,old.section_id,old.subject_id);
  end if;
  if tg_op='DELETE' then return old; end if;
  if tg_op='UPDATE' and new.id is distinct from old.id then
    raise exception 'An assessment identifier cannot be changed.' using errcode='42501';
  end if;
  if tg_op='UPDATE' and (new.school_id,new.academic_year_id,new.class_id,new.section_id,new.subject_id,new.teacher_id)
    is distinct from (old.school_id,old.academic_year_id,old.class_id,old.section_id,old.subject_id,old.teacher_id)
    and exists (select 1 from public.teacher_assessment_marks where assessment_id=old.id) then
    raise exception 'An assessment with saved marks cannot be moved to another placement or teacher.' using errcode='42501';
  end if;
  perform app_private.lock_assessment_write_scope(new.teacher_id,new.school_id,new.academic_year_id,new.class_id,new.section_id,new.subject_id);
  if app_private.assessment_school_admin(new.school_id) and (tg_op='INSERT'
    or (new.school_id,new.academic_year_id,new.class_id,new.section_id,new.subject_id,new.teacher_id)
      is distinct from (old.school_id,old.academic_year_id,old.class_id,old.section_id,old.subject_id,old.teacher_id)) then
    perform 1 from public.teacher_subject_assignments assignment
      where assignment.teacher_id=new.teacher_id and assignment.academic_year_id=new.academic_year_id
        and assignment.class_id=new.class_id and assignment.subject_id=new.subject_id
        and (assignment.section_id is null or assignment.section_id=new.section_id)
      for share;
    if not found then
      raise exception 'Choose a teacher assigned to this class, section and subject. A whole-class assessment needs a whole-class assignment.'
        using errcode='22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_assessment_write() from public,anon,authenticated,service_role;

commit;
