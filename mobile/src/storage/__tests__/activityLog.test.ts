jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { addActivityEntry, getActivityLog, type ActivityEntry } from "../activityLog";

const KEY = "@uiuc_bus_activity_log";

function makeEntry(i: number): ActivityEntry {
  return {
    id: `seed-${i}`,
    date: "2026-09-01",
    walkingModeId: "walk",
    distanceM: 800,
    stepCount: 1000,
    durationSeconds: 600,
    caloriesBurned: 40,
    from: "Home",
    to: "Siebel",
  };
}

describe("activityLog persistence cap", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it("appends a new entry with a generated id", async () => {
    const { id: _ignored, ...rest } = makeEntry(0);
    const entry = await addActivityEntry(rest);
    expect(entry.id).toBeTruthy();
    const log = await getActivityLog();
    expect(log).toHaveLength(1);
    expect(log[0].to).toBe("Siebel");
  });

  it("caps the persisted log at 365 entries, dropping the oldest", async () => {
    const seeded = Array.from({ length: 365 }, (_, i) => makeEntry(i));
    await AsyncStorage.setItem(KEY, JSON.stringify(seeded));

    const { id: _drop, ...newEntry } = makeEntry(999);
    await addActivityEntry(newEntry);

    const stored = JSON.parse((await AsyncStorage.getItem(KEY))!) as ActivityEntry[];
    expect(stored).toHaveLength(365);
    // Oldest seed entry dropped, newest entry retained at the end
    expect(stored.find((e) => e.id === "seed-0")).toBeUndefined();
    expect(stored[0].id).toBe("seed-1");
    expect(stored[stored.length - 1].to).toBe("Siebel");
  });

  it("returns [] for missing or malformed storage", async () => {
    expect(await getActivityLog()).toEqual([]);
    await AsyncStorage.setItem(KEY, "{corrupt");
    expect(await getActivityLog()).toEqual([]);
    await AsyncStorage.setItem(KEY, JSON.stringify({ notAnArray: true }));
    expect(await getActivityLog()).toEqual([]);
  });
});
