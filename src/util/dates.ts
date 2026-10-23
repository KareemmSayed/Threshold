/** Calendar-date helpers. Dates are `YYYY-MM-DD` strings in the athlete's local calendar. */

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Every date from `start` to `end`, inclusive. */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Today's date in an IANA time zone. Falls back to UTC for an unknown zone. */
export function todayIn(timeZone: string | undefined, now = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Monday of the ISO week that contains `date`. */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** ISO week label, e.g. `2026-W43`. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const thursday = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Split an inclusive range into consecutive windows of at most `maxDays` days. */
export function windows(start: string, end: string, maxDays: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let s = start; s <= end; ) {
    const e = addDays(s, maxDays - 1) < end ? addDays(s, maxDays - 1) : end;
    out.push([s, e]);
    s = addDays(e, 1);
  }
  return out;
}

/** Group sorted dates into runs of consecutive days, each at most `maxDays` long. */
export function runs(dates: string[], maxDays: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let first: string | null = null;
  let last: string | null = null;
  let len = 0;
  for (const d of dates) {
    if (first !== null && last !== null && addDays(last, 1) === d && len < maxDays) {
      last = d;
      len++;
      continue;
    }
    if (first !== null && last !== null) out.push([first, last]);
    first = d;
    last = d;
    len = 1;
  }
  if (first !== null && last !== null) out.push([first, last]);
  return out;
}

/** `YYYY-MM-DD` from Garmin's local timestamps (`2026-10-20 07:12:03`, `2026-10-20T07:12:03.0`). */
export function datePart(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const d = value.slice(0, 10);
  return isIsoDate(d) ? d : null;
}
