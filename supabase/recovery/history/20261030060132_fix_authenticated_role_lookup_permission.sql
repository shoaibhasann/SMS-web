grant execute on function public.current_user_school_ids() to authenticated;
revoke execute on function public.current_user_school_ids() from anon;

-- Keep the helper constrained to the current authenticated user's school IDs.
alter function public.current_user_school_ids() set search_path = public;