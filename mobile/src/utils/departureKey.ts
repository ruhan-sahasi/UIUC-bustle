import type { DepartureItem } from "@/src/api/types";

/**
 * Stable React keys for a live departure list.
 *
 * The list reorders as buses leave, and DepartureRow keeps per-row state
 * (countdown phase, odometer), so index keys made one bus's row inherit the
 * previous bus's state. Keys come from the bus identity instead; repeats
 * (the same trip listed twice) get an occurrence suffix so keys stay unique.
 */
export function departureKeys(departures: Pick<DepartureItem, "route" | "headsign" | "expected_time_iso" | "expected_mins">[]): string[] {
  const seen = new Map<string, number>();
  return departures.map((d) => {
    const when = d.expected_time_iso ?? `+${d.expected_mins}`;
    const base = `${d.route}|${d.headsign}|${when}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}
