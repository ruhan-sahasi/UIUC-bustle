import AsyncStorage from "@react-native-async-storage/async-storage";

export interface StopThreshold {
  stop_id: string;
  stop_name: string;
  route_id: string; // which route to watch
  threshold_mins: number; // alert when bus is this many minutes away
  enabled: boolean;
}

const KEY = "@uiuc_bus_stop_thresholds";

export async function getStopThresholds(): Promise<StopThreshold[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // A non-array value would make findIndex/filter throw in the writers.
    return Array.isArray(parsed) ? (parsed as StopThreshold[]) : [];
  } catch {
    return [];
  }
}

export async function setStopThreshold(t: StopThreshold): Promise<void> {
  const existing = await getStopThresholds();
  const idx = existing.findIndex(
    (e) => e.stop_id === t.stop_id && e.route_id === t.route_id
  );
  if (idx >= 0) {
    existing[idx] = t;
  } else {
    existing.push(t);
  }
  await AsyncStorage.setItem(KEY, JSON.stringify(existing));
}

export async function removeStopThreshold(
  stop_id: string,
  route_id: string
): Promise<void> {
  const existing = await getStopThresholds();
  const filtered = existing.filter(
    (e) => !(e.stop_id === stop_id && e.route_id === route_id)
  );
  await AsyncStorage.setItem(KEY, JSON.stringify(filtered));
}
