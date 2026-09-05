/** 'YYYY-MM-DD' -> 'YYYY-MM'. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** 'YYYY-MM' plus delta months (delta may be negative). */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Number of days in 'YYYY-MM'. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' plus delta days (delta may be negative). */
export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Today (UTC) as 'YYYY-MM-DD'. */
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Now as ISO-8601 UTC. */
export function nowIso(): string {
  return new Date().toISOString();
}
