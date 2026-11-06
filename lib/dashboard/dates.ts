export function upcomingAssessmentEndDate(today: string): string {
  const end = new Date(`${today}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 7);
  return end.toISOString().slice(0, 10);
}
