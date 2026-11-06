import { createClient } from '@/lib/supabase/client';
import { readCompletePages } from '@/lib/complete-pages';

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
  existingActivities?: AcademicActivity[];
  expected_updated_at?: string;
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
  updated_at?: string;
};

export type AcademicActivity = {
  id: string;
  class_log_id: string;
  activity_type: string;
  title: string;
  description: string | null;
  due_date: string | null;
  attachment_url?: string | null;
  max_marks?: number | null;
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

  const names = currentYearOnly ? 'classes!inner(name,is_active), sections!inner(name), subjects!inner(name,is_active)' : 'classes(name), sections(name), subjects(name)';
  const columns = `id, teacher_id, class_id, section_id, subject_id, academic_year_id, is_class_teacher, ${names}`;
  const query = supabase
    .from('teacher_subject_assignments')
    .select(currentYearOnly ? `${columns}, academic_years!inner(is_current)` : columns)
    .eq('teacher_id', teacherId);
  if (currentYearOnly) query.eq('classes.is_active', true).eq('subjects.is_active', true);
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

export type AcademicLogFilters = {
  teacherId?: string;
  schoolId?: string;
  academicYearId?: string;
  academicYearIds?: string[];
  classIds?: string[];
  sectionIds?: string[];
  subjectId?: string;
  logDate?: string;
  activityType?: (typeof activityTypes)[number][0];
  status?: 'draft' | 'published';
};

export async function loadAcademicLogs(filters: AcademicLogFilters = {}): Promise<AcademicLogRecord[]> {
  if (filters.classIds?.length === 0 || filters.sectionIds?.length === 0 || filters.academicYearIds?.length === 0) return [];
  const supabase = createClient();
  // shortcut: loads the complete chosen scope, use a cursor UI for large multi-year history.
  return readCompletePages<AcademicLogRecord>((from, to) => {
    let query = supabase.from('class_logs')
      .select(`id, school_id, academic_year_id, log_date, class_id, section_id, subject_id, teacher_id, topic, summary, teacher_remark, status, published_at, updated_at${filters.activityType ? ',class_activities!inner(activity_type)' : ''}`, { count: 'exact' })
      .order('log_date', { ascending: false }).order('id');
    if (filters.teacherId) query = query.eq('teacher_id', filters.teacherId);
    if (filters.schoolId) query = query.eq('school_id', filters.schoolId);
    if (filters.academicYearId) query = query.eq('academic_year_id', filters.academicYearId);
    if (filters.academicYearIds?.length) query = query.in('academic_year_id', filters.academicYearIds);
    if (filters.classIds?.length) query = query.in('class_id', filters.classIds);
    if (filters.sectionIds?.length) query = query.in('section_id', filters.sectionIds);
    if (filters.subjectId) query = query.eq('subject_id', filters.subjectId);
    if (filters.logDate) query = query.eq('log_date', filters.logDate);
    if (filters.activityType) query = query.eq('class_activities.activity_type', filters.activityType);
    if (filters.status) query = query.eq('status', filters.status);
    return query.range(from, to).returns<AcademicLogRecord[]>();
  }, 'Academic history');
}

export async function loadAcademicActivities(logIds: string[]): Promise<AcademicActivity[]> {
  if (!logIds.length) return [];
  const supabase = createClient();
  const uniqueIds = [...new Set(logIds)];
  const activities: AcademicActivity[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const ids = uniqueIds.slice(offset, offset + 100);
    const rows = await readCompletePages<AcademicActivity>((from, to) => supabase
      .from('class_activities')
      .select('id, class_log_id, activity_type, title, description, due_date, attachment_url, max_marks', { count: 'exact' })
      .in('class_log_id', ids).order('id').range(from, to).returns<AcademicActivity[]>(), 'Academic activities');
    const allowed = new Set(ids);
    for (const row of rows) {
      if (!allowed.has(row.class_log_id) || seen.has(row.id)) {
        throw new Error('Academic activities changed or returned an unexpected source log. Refresh before editing.');
      }
      seen.add(row.id);
    }
    activities.push(...rows);
  }
  return activities;
}

export async function saveAcademicLog(log: AcademicLog) {
  if (log.id && !Array.isArray(log.existingActivities)) {
    throw new Error('Load the complete activity list before editing this log. Your draft has not been saved.');
  }
  const existing = log.existingActivities ?? [];
  const rows: AcademicActivityWrite[] = [];
  const preserve = (activity: AcademicActivity) => ({ id: activity.id, activity_type: activity.activity_type, title: activity.title,
    description: activity.description, due_date: activity.due_date, attachment_url: activity.attachment_url ?? null, max_marks: activity.max_marks ?? null });
  for (const [type, label] of activityTypes) {
    const previous = existing.filter((activity) => activity.activity_type === type);
    if (previous.length > 1) {
      // The log form has one field per type. Never collapse multiple homework entries.
      rows.push(...previous.map(preserve));
      continue;
    }
    const title = log.activities[type]?.trim();
    if (!title) continue;
    const prior = previous[0];
    rows.push({ ...(prior ? { id: prior.id } : {}), activity_type: type, title,
      description: prior?.description ?? label, due_date: prior?.due_date ?? null,
      attachment_url: prior?.attachment_url ?? null, max_marks: prior?.max_marks ?? null,
    });
  }
  // Preserve types not represented by the fixed log form.
  const knownTypes = new Set<string>(activityTypes.map(([type]) => type));
  rows.push(...existing.filter((activity) => !knownTypes.has(activity.activity_type))
    .map(preserve));
  return saveAcademicLogWithActivities(log, rows);
}

export type AcademicActivityWrite = Omit<AcademicActivity, 'id' | 'class_log_id'> & { id?: string };

export async function saveAcademicLogWithActivities(log: Omit<AcademicLog, 'activities' | 'existingActivities'>, rows: AcademicActivityWrite[]) {
  if (log.id && !log.expected_updated_at) throw new Error('Refresh the source log before saving so its latest work is preserved.');
  const supabase = createClient();
  const payload = {
    ...(log.id ? { id: log.id, expected_updated_at: log.expected_updated_at } : {}),
    school_id: log.school_id,
    academic_year_id: log.academic_year_id,
    class_id: log.class_id,
    section_id: log.section_id,
    subject_id: log.subject_id,
    log_date: log.log_date,
    topic: log.topic.trim(),
    summary: log.summary.trim(),
    teacher_remark: log.teacher_remark?.trim() || null,
    status: log.status ?? 'draft',
  };
  const { data, error } = await supabase.rpc('save_academic_log', { p_log: payload, p_activities: rows });
  if (error) throw error;
  if (typeof data !== 'string' || !data) throw new Error('Academic work was not saved. Refresh your teaching assignments before trying again.');
  return { id: data };
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
