import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@uiuc_bus_last_home";

// Snapshots older than this are treated as absent on read. Every consumer
// already handles a null read (cold-start placeholder stays empty, background
// tasks fall back to a live fetch or NoData), so expiring stale data only
// shortens how long a plaintext location snapshot lingers on disk.
export const LAST_KNOWN_HOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Persisted coordinates are rounded to 4 decimal places (~11 m). The cached
// snapshot only feeds placeholder distance maths and route recommendations,
// which tolerate that error; it keeps a precise home fix out of plaintext
// AsyncStorage.
function roundCoord(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export interface LastKnownHomeData {
  stops: Array<{ stop_id: string; stop_name: string; lat: number; lng: number; distance_m: number }>;
  departuresByStop: Record<string, Array<{ route: string; headsign: string; expected_mins: number }>>;
  scheduleClasses: Array<{
    class_id: string;
    title: string;
    days_of_week: string[];
    start_time_local: string;
    building_id: string;
    destination_lat?: number | null;
    destination_lng?: number | null;
    destination_name?: string | null;
  }>;
  recommendations: Array<{
    type: string;
    summary: string;
    eta_minutes: number;
    depart_in_minutes: number;
    steps: unknown[];
  }>;
  location?: { lat: number; lng: number };
  savedAt: number;
}

export async function getLastKnownHomeData(): Promise<LastKnownHomeData | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as LastKnownHomeData;
    if (!data.stops || !data.scheduleClasses) return null;
    if (typeof data.savedAt !== "number" || Date.now() - data.savedAt > LAST_KNOWN_HOME_TTL_MS) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function setLastKnownHomeData(data: Omit<LastKnownHomeData, "savedAt">): Promise<void> {
  try {
    const rounded: LastKnownHomeData = {
      ...data,
      stops: data.stops.map((s) => ({ ...s, lat: roundCoord(s.lat), lng: roundCoord(s.lng) })),
      scheduleClasses: data.scheduleClasses.map((c) => ({
        ...c,
        destination_lat: c.destination_lat == null ? c.destination_lat : roundCoord(c.destination_lat),
        destination_lng: c.destination_lng == null ? c.destination_lng : roundCoord(c.destination_lng),
      })),
      location: data.location
        ? { lat: roundCoord(data.location.lat), lng: roundCoord(data.location.lng) }
        : data.location,
      savedAt: Date.now(),
    };
    await AsyncStorage.setItem(KEY, JSON.stringify(rounded));
  } catch (_) {}
}
