-- Remove API execute privileges from SECURITY DEFINER helpers by default.
REVOKE EXECUTE ON FUNCTION public.activate_parent(text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.activate_student(text,date,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.activate_teacher(text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_school_role(uuid,uuid,public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_user_has_any_role(public.app_role[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_user_has_role(public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_user_school_ids() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_public_rls() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_role(public.app_role,uuid) FROM PUBLIC, anon, authenticated;
-- Activation is part of the signed-in onboarding flow; role assignment remains server-authorized internally.
GRANT EXECUTE ON FUNCTION public.activate_parent(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_student(text,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_teacher(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_school_role(uuid,uuid,public.app_role) TO authenticated;
-- Make security-sensitive views obey the querying user's permissions/RLS.
ALTER VIEW public.student_missed_activities SET (security_invoker = true);
ALTER VIEW public.student_fee_summary SET (security_invoker = true);
ALTER VIEW public.report_card_subject_summary SET (security_invoker = true);