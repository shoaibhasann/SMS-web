ALTER FUNCTION public.set_updated_at() SET search_path = pg_catalog, public;
ALTER FUNCTION public.current_user_id() SET search_path = pg_catalog, public;
REVOKE EXECUTE ON FUNCTION public.current_user_has_any_role(public.app_role[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_user_has_role(public.app_role) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_user_school_ids() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_role(public.app_role, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_public_rls() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_school_role(uuid, uuid, public.app_role) FROM anon;
GRANT EXECUTE ON FUNCTION public.activate_parent(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_student(text,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_teacher(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_school_role(uuid,uuid,public.app_role) TO authenticated;

DROP POLICY IF EXISTS inventory_transactions_school_member ON public.inventory_transactions;
CREATE POLICY inventory_transactions_school_member ON public.inventory_transactions FOR ALL TO authenticated USING (item_id IN (SELECT id FROM public.inventory_items WHERE school_id IN (SELECT public.current_user_school_ids()))) WITH CHECK (item_id IN (SELECT id FROM public.inventory_items WHERE school_id IN (SELECT public.current_user_school_ids())));

DROP POLICY IF EXISTS leave_balances_school_member ON public.leave_balances;
CREATE POLICY leave_balances_school_member ON public.leave_balances FOR ALL TO authenticated USING (employee_id IN (SELECT id FROM public.employees WHERE school_id IN (SELECT public.current_user_school_ids()))) WITH CHECK (employee_id IN (SELECT id FROM public.employees WHERE school_id IN (SELECT public.current_user_school_ids())));

DROP POLICY IF EXISTS notification_logs_school_member ON public.notification_logs;
CREATE POLICY notification_logs_school_member ON public.notification_logs FOR ALL TO authenticated USING (notification_id IN (SELECT id FROM public.notifications WHERE school_id IN (SELECT public.current_user_school_ids()))) WITH CHECK (notification_id IN (SELECT id FROM public.notifications WHERE school_id IN (SELECT public.current_user_school_ids())));

DROP POLICY IF EXISTS report_cards_school_member ON public.report_cards;
CREATE POLICY report_cards_school_member ON public.report_cards FOR ALL TO authenticated USING (school_id IN (SELECT public.current_user_school_ids())) WITH CHECK (school_id IN (SELECT public.current_user_school_ids()));

DROP POLICY IF EXISTS transport_assignments_school_member ON public.transport_assignments;
CREATE POLICY transport_assignments_school_member ON public.transport_assignments FOR ALL TO authenticated USING (route_id IN (SELECT id FROM public.transport_routes WHERE school_id IN (SELECT public.current_user_school_ids()))) WITH CHECK (route_id IN (SELECT id FROM public.transport_routes WHERE school_id IN (SELECT public.current_user_school_ids())));

UPDATE storage.buckets SET public = false WHERE id IN ('school-assets','student-documents','study-materials','report-cards');
DROP POLICY IF EXISTS school_assets_authenticated_access ON storage.objects;
CREATE POLICY school_assets_authenticated_access ON storage.objects FOR ALL TO authenticated USING (bucket_id='school-assets' AND (storage.foldername(name))[1] IN (SELECT public.current_user_school_ids()::text)) WITH CHECK (bucket_id='school-assets' AND (storage.foldername(name))[1] IN (SELECT public.current_user_school_ids()::text));
DROP POLICY IF EXISTS student_documents_authenticated_access ON storage.objects;
CREATE POLICY student_documents_authenticated_access ON storage.objects FOR ALL TO authenticated USING (bucket_id='student-documents' AND (storage.foldername(name))[1] IN (SELECT public.current_user_school_ids()::text)) WITH CHECK (bucket_id='student-documents' AND (storage.foldername(name))[1] IN (SELECT public.current_user_school_ids()::text));
DROP POLICY IF EXISTS study_materials_authenticated_access ON storage.objects;
CREATE POLICY study_materials_authenticated_access ON storage.objects FOR ALL TO authenticated USING (bucket_id='study-materials' AND (storage.foldername(name))[1] IN (SELECT public.current_user_school_ids()::text)) WITH CHECK (bucket_id='study-materials' AND (storage.foldername(name))[1] IN (SELECT public.current_user_school_ids()::text));
DROP POLICY IF EXISTS report_cards_authenticated_access ON storage.objects;
CREATE POLICY report_cards_authenticated_access ON storage.objects FOR ALL TO authenticated USING (bucket_id='report-cards' AND (storage.foldername(name))[1] IN (SELECT public.current_user_school_ids()::text)) WITH CHECK (bucket_id='report-cards' AND (storage.foldername(name))[1] IN (SELECT public.current_user_school_ids()::text));