create index if not exists notifications_queue_idx on public.notifications(status,scheduled_at) where status='queued';
create index if not exists notifications_recipient_idx on public.notifications(recipient_user_id,created_at desc);
create index if not exists notification_logs_notification_idx on public.notification_logs(notification_id,created_at desc);
create index if not exists communication_logs_status_idx on public.communication_logs(status,created_at desc);