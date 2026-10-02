jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addActivityEntry,
  calcStreak,
  dateStringForOffset,
  getActivityLog,
  getWeeklyStepGoal,
  setWeeklyStepGoal,
  WEEKLY_STEP_GOAL,
  type ActivityEntry,
} from "../activityLog";

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


function stepsOn(offset: number, stepCount: number): ActivityEntry {
  return { ...makeEntry(offset), id: `d-${offset}-${stepCount}`, date: dateStringForOffset(offset), stepCount };
}

describe("calcStreak", () => {
  it("counts consecutive qualifying days ending today", () => {
    expect(calcStreak([stepsOn(0, 600), stepsOn(1, 900), stepsOn(2, 700)])).toBe(3);
  });

  it("sums multiple walks on the same day", () => {
    expect(calcStreak([stepsOn(0, 300), stepsOn(0, 300)])).toBe(1);
  });

  it("does not reset to 0 before today's first walk", () => {
    // Yesterday and the day before qualified; nothing logged yet today.
    expect(calcStreak([stepsOn(1, 900), stepsOn(2, 700)])).toBe(2);
  });

  it("breaks on a missed day in the past", () => {
    expect(calcStreak([stepsOn(0, 900), stepsOn(2, 900)])).toBe(1);
    expect(calcStreak([stepsOn(2, 900)])).toBe(0);
  });

  it("terminates with a zero threshold and ignores junk step counts", () => {
    const junk = { ...stepsOn(1, 0), stepCount: "lots" as unknown as number };
    expect(calcStreak([stepsOn(0, 10), junk], 0)).toBe(1);
    expect(calcStreak([], 0)).toBe(0);
  });
});

describe("weekly step goal", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it("falls back to the default for missing, zero, negative, or junk values", async () => {
    expect(await getWeeklyStepGoal()).toBe(WEEKLY_STEP_GOAL);
    for (const raw of ["0", "-5", "abc"]) {
      await AsyncStorage.setItem("@uiuc_bus_weekly_step_goal", raw);
      expect(await getWeeklyStepGoal()).toBe(WEEKLY_STEP_GOAL);
    }
  });

  it("stores a rounded goal with a 1000-step floor", async () => {
    await setWeeklyStepGoal(42_000.6);
    expect(await getWeeklyStepGoal()).toBe(42_001);
    await setWeeklyStepGoal(10);
    expect(await getWeeklyStepGoal()).toBe(1000);
    await setWeeklyStepGoal(NaN);
    expect(await getWeeklyStepGoal()).toBe(WEEKLY_STEP_GOAL);
  });
});
