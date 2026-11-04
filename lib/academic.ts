import { createClient } from '@/lib/supabase/client';

export type TeachingAssignment = {
  id: string;
  teacher_id: string;
  class_id: string;
  section_id: string;
  subject_id: string;
  academic_year_id: string;
  is_class_teacher: boolean;
  class_name: string;
  section_name: string;
  subject_name: string;
};

export type AcademicActivityMap = Record<string, string>;

export type AcademicLog = {
  id?: string;
  school_id: string;
  academic_year_id: string;
  log_date: string;
  class_id: string;
  section_id: string;
  subject_id: string;
  topic: string;
  summary: string;
  teacher_remark?: string;
  activities: AcademicActivityMap;
  status?: 'draft' | 'published';
};

export type AcademicLogRecord = {
  id: string;
  school_id: string;
  academic_year_id: string;
  log_date: string;
  class_id: string;
  section_id: string;
  subject_id: string;
  teacher_id: string;
  topic: string;
  summary: string;
  teacher_remark: string | null;
  status: 'draft' | 'published';
  published_at: string | null;
};

export type AcademicActivity = {
  id: string;
  class_log_id: string;
  activity_type: string;
  title: string;
  description: string | null;
  due_date: string | null;
};

export const activityTypes = [
  ['classwork', 'Classwork'],
  ['homework', 'Homework'],
  ['assignment', 'Assignment'],
  ['project', 'Project'],
  ['practical', 'Practical'],
  ['activity', 'Activity'],
  ['study_material', 'Study Material'],
] as const;

export async function getCurrentTeacherId() {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!user) return null;

  const { data, error } = await supabase
    .from('teachers')
    .select('id')
    .eq('profile_id', user.id)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

type JoinedName = { name: string } | { name: string }[] | null;
type AssignmentReadRow = Omit<TeachingAssignment, 'class_name' | 'section_name' | 'subject_name'> & {
  classes: JoinedName; sections: JoinedName; subjects: JoinedName;
};
function joinedName(value: JoinedName, fallback: string) {
  return (Array.isArray(value) ? value[0]?.name : value?.name) ?? fallback;
}

export async function getCurrentTeacherAssignments({ currentYearOnly = false } = {}): Promise<TeachingAssignment[]> {
  const supabase = createClient();
  const teacherId = await getCurrentTeacherId();
  if (!teacherId) return [];

  const columns = 'id, teacher_id, class_id, section_id, subject_id, academic_year_id, is_class_teacher, classes(name), sections(name), subjects(name)';
  const query = supabase
    .from('teacher_subject_assignments')
    .select(currentYearOnly ? `${columns}, academic_years!inner(is_current)` : columns)
    .eq('teacher_id', teacherId);
  const { data, error } = await (currentYearOnly ? query.eq('academic_years.is_current', true) : query);
  if (error) throw error;

  return ((data ?? []) as unknown as AssignmentReadRow[]).map((row) => ({
    id: row.id,
    teacher_id: row.teacher_id,
    class_id: row.class_id,
    section_id: row.section_id,
    subject_id: row.subject_id,
    academic_year_id: row.academic_year_id,
    is_class_teacher: Boolean(row.is_class_teacher),
    class_name: joinedName(row.classes, 'Class'),
    section_name: joinedName(row.sections, 'Section'),
    subject_name: joinedName(row.subjects, 'Subject'),
  }));
}

export async function loadAcademicLogs(filters: {
  teacherId?: string;
  schoolId?: string;
  academicYearId?: string;
  classIds?: string[];
  sectionIds?: string[];
  status?: 'draft' | 'published';
} = {}): Promise<AcademicLogRecord[]> {
  const supabase = createClient();
  let query = supabase
    .from('class_logs')
    .select('id, school_id, academic_year_id, log_date, class_id, section_id, subject_id, teacher_id, topic, summary, teacher_remark, status, published_at')
    .order('log_date', { ascending: false })
    .limit(200);

  if (filters.teacherId) query = query.eq('teacher_id', filters.teacherId);
  if (filters.schoolId) query = query.eq('school_id', filters.schoolId);
  if (filters.academicYearId) query = query.eq('academic_year_id', filters.academicYearId);
  if (filters.classIds?.length) query = query.in('class_id', filters.classIds);
  if (filters.sectionIds?.length) query = query.in('section_id', filters.sectionIds);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AcademicLogRecord[];
}

export async function loadAcademicActivities(logIds: string[]): Promise<AcademicActivity[]> {
  if (!logIds.length) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from('class_activities')
    .select('id, class_log_id, activity_type, title, description, due_date')
    .in('class_log_id', logIds);
  if (error) throw error;
  return (data ?? []) as AcademicActivity[];
}

export async function saveAcademicLog(log: AcademicLog) {
  const supabase = createClient();
  const teacherId = await getCurrentTeacherId();
  if (!teacherId) throw new Error('Teacher profile was not found for this login.');

  const payload = {
    ...(log.id ? { id: log.id } : {}),
    school_id: log.school_id,
    academic_year_id: log.academic_year_id,
    class_id: log.class_id,
    section_id: log.section_id,
    subject_id: log.subject_id,
    teacher_id: teacherId,
    log_date: log.log_date,
    topic: log.topic.trim(),
    summary: log.summary.trim(),
    teacher_remark: log.teacher_remark?.trim() || null,
    status: log.status ?? 'draft',
  };

  const { data: saved, error } = await supabase
    .from('class_logs')
    .upsert(payload, { onConflict: 'section_id,subject_id,log_date,teacher_id' })
    .select('id')
    .single();
  if (error) throw error;

  const { error: deleteError } = await supabase
    .from('class_activities')
    .delete()
    .eq('class_log_id', saved.id);
  if (deleteError) throw deleteError;

  const rows = activityTypes
    .filter(([type]) => log.activities[type]?.trim())
    .map(([type, label]) => ({
      class_log_id: saved.id,
      activity_type: type,
      title: log.activities[type].trim(),
      description: label,
    }));

  if (rows.length) {
    const { error: activityError } = await supabase.from('class_activities').insert(rows);
    if (activityError) throw activityError;
  }

  return saved;
}

export async function publishAcademicLog(id: string) {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!user) throw new Error('Please sign in before publishing academic work.');

  const { data, error } = await supabase
    .from('class_logs')
    .update({ status: 'published', published_at: new Date().toISOString(), published_by: user.id })
    .eq('id', id)
    .select('id, status')
    .single();
  if (error) throw error;
  return data;
}
