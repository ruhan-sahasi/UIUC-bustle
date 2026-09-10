jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getLastKnownHomeData,
  setLastKnownHomeData,
  LAST_KNOWN_HOME_TTL_MS,
  type LastKnownHomeData,
} from "../lastKnownHome";

const KEY = "@uiuc_bus_last_home";

function sampleData(): Omit<LastKnownHomeData, "savedAt"> {
  return {
    stops: [
      { stop_id: "s1", stop_name: "Transit Plaza", lat: 40.10945678, lng: -88.22723456, distance_m: 120 },
    ],
    departuresByStop: { s1: [{ route: "22", headsign: "Illini", expected_mins: 4 }] },
    scheduleClasses: [
      {
        class_id: "c1",
        title: "CS 225",
        days_of_week: ["M", "W"],
        start_time_local: "10:00",
        building_id: "siebel",
        destination_lat: 40.11387654,
        destination_lng: -88.22491234,
        destination_name: "Siebel",
      },
    ],
    recommendations: [],
    location: { lat: 40.10212345, lng: -88.22726789 },
  };
}

describe("lastKnownHome", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  it("round-trips a fresh snapshot", async () => {
    await setLastKnownHomeData(sampleData());
    const data = await getLastKnownHomeData();
    expect(data).not.toBeNull();
    expect(data!.stops[0].stop_id).toBe("s1");
    expect(data!.departuresByStop.s1[0].route).toBe("22");
    expect(typeof data!.savedAt).toBe("number");
  });

  it("rounds all persisted coordinates to 4 decimal places (~11 m)", async () => {
    await setLastKnownHomeData(sampleData());
    const stored = JSON.parse((await AsyncStorage.getItem(KEY))!) as LastKnownHomeData;
    expect(stored.stops[0].lat).toBe(40.1095);
    expect(stored.stops[0].lng).toBe(-88.2272);
    expect(stored.location).toEqual({ lat: 40.1021, lng: -88.2273 });
    expect(stored.scheduleClasses[0].destination_lat).toBe(40.1139);
    expect(stored.scheduleClasses[0].destination_lng).toBe(-88.2249);
    // Non-coordinate fields untouched
    expect(stored.stops[0].distance_m).toBe(120);
  });

  it("leaves absent location and null destination coords as-is", async () => {
    const data = sampleData();
    delete data.location;
    data.scheduleClasses[0].destination_lat = null;
    data.scheduleClasses[0].destination_lng = null;
    await setLastKnownHomeData(data);
    const stored = JSON.parse((await AsyncStorage.getItem(KEY))!) as LastKnownHomeData;
    expect(stored.location).toBeUndefined();
    expect(stored.scheduleClasses[0].destination_lat).toBeNull();
    expect(stored.scheduleClasses[0].destination_lng).toBeNull();
  });

  it("returns data within the 7-day TTL", async () => {
    const snapshot = { ...sampleData(), savedAt: Date.now() - (LAST_KNOWN_HOME_TTL_MS - 60_000) };
    await AsyncStorage.setItem(KEY, JSON.stringify(snapshot));
    expect(await getLastKnownHomeData()).not.toBeNull();
  });

  it("treats a snapshot older than 7 days as absent", async () => {
    const snapshot = { ...sampleData(), savedAt: Date.now() - (LAST_KNOWN_HOME_TTL_MS + 60_000) };
    await AsyncStorage.setItem(KEY, JSON.stringify(snapshot));
    expect(await getLastKnownHomeData()).toBeNull();
  });

  it("treats a snapshot with a missing/invalid savedAt as absent", async () => {
    const snapshot = sampleData() as Record<string, unknown>;
    await AsyncStorage.setItem(KEY, JSON.stringify(snapshot));
    expect(await getLastKnownHomeData()).toBeNull();
  });

  it("returns null for missing or malformed storage", async () => {
    expect(await getLastKnownHomeData()).toBeNull();
    await AsyncStorage.setItem(KEY, "not-json{");
    expect(await getLastKnownHomeData()).toBeNull();
    await AsyncStorage.setItem(KEY, JSON.stringify({ foo: 1 }));
    expect(await getLastKnownHomeData()).toBeNull();
  });
});
