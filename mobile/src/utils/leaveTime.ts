/**
 * Clock-time helpers for "leave by" displays.
 *
 * Note the two different reference points: the backend's depart_in_minutes is
 * measured from *now* (when the recommendation was fetched), while a fallback
 * estimate like "15 min before class" is measured back from the class start.
 */

export function padTime(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** "HH:MM" that is `minutes` before the class start time (wraps past midnight). */
export function clockTimeBefore(startTime: string, minutes: number): string {
  const total = minutesOfDay(startTime) - Math.round(minutes);
  const wrapped = ((total % 1440) + 1440) % 1440;
  return padTime(Math.floor(wrapped / 60), wrapped % 60);
}

/** "HH:MM" that is `minutes` after `now` — for depart_in_minutes from the API. */
export function clockTimeAfter(now: Date, minutes: number): string {
  const d = new Date(now.getTime() + Math.round(minutes) * 60_000);
  return padTime(d.getHours(), d.getMinutes());
}

/** Whole minutes from `now` until `minutes` before the class start time. */
export function minutesUntilBefore(startTime: string, minutes: number, now: Date): number {
  const nowMins = now.getHours() * 60 + now.getMinutes();
  return minutesOfDay(startTime) - Math.round(minutes) - nowMins;
}
