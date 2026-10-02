import type { ScheduleClass } from "@/src/api/types";

const mockSchedule = jest.fn();
const mockCancel = jest.fn();
const mockGetAll = jest.fn(async () => [] as { identifier: string }[]);
let mockGranted = true;

jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: mockGranted })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
  cancelScheduledNotificationAsync: (...args: unknown[]) => mockCancel(...args),
  getAllScheduledNotificationsAsync: () => mockGetAll(),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  setNotificationHandler: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval", DATE: "date" },
}));

jest.mock("@/src/storage/classSummaryCache", () => ({
  getClassSummary: jest.fn(async () => null),
  getClassRouteData: jest.fn(async () => null),
}));
jest.mock("@/src/storage/walkedClassToday", () => ({
  getWalkedClassIdsToday: jest.fn(async () => []),
}));
jest.mock("@/src/storage/classNotifPrefs", () => ({
  getDisabledClassIds: jest.fn(async () => []),
}));

import { scheduleClassReminders, cancelClassReminder } from "../classReminders";
import { getClassSummary, getClassRouteData } from "@/src/storage/classSummaryCache";
import { getWalkedClassIdsToday } from "@/src/storage/walkedClassToday";
import { getDisabledClassIds } from "@/src/storage/classNotifPrefs";

function makeClass(over: Partial<ScheduleClass> = {}): ScheduleClass {
  return {
    class_id: "c1",
    title: "CS 233",
    days_of_week: ["MON", "WED", "FRI"],
    start_time_local: "09:00",
    building_id: "siebel",
    ...over,
  };
}

/** Identifiers scheduled during the last call, in fire order. */
function scheduledIds(): string[] {
  return mockSchedule.mock.calls.map((c) => c[0].identifier);
}

describe("scheduleClassReminders", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGranted = true;
    (getClassSummary as jest.Mock).mockResolvedValue(null);
    (getClassRouteData as jest.Mock).mockResolvedValue(null);
    (getWalkedClassIdsToday as jest.Mock).mockResolvedValue([]);
    (getDisabledClassIds as jest.Mock).mockResolvedValue([]);
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it("schedules a Monday class from a Sunday evening", async () => {
    // The original same-day-only implementation produced NOTHING here: it
    // filtered to Sunday's classes, found none, and relied on iOS background
    // fetch to recover before 8:40 AM Monday.
    jest.setSystemTime(new Date(2026, 2, 1, 20, 0, 0)); // Sunday 8:00 PM
    await scheduleClassReminders([makeClass()], { siebel: "Siebel Center" });

    const ids = scheduledIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((i) => i.startsWith("class-c1-20260302"))).toBe(true);
  });

  it("anchors each occurrence to its own date", async () => {
    jest.setSystemTime(new Date(2026, 2, 1, 20, 0, 0)); // Sunday
    await scheduleClassReminders([makeClass()], {});

    // The horizon is 5 days from Sunday 3/1: Sun 3/1 .. Thu 3/5.
    // MON 3/2 and WED 3/4 are in range; FRI 3/6 is day 6 and is not.
    const ids = scheduledIds();
    expect(ids.some((i) => i.includes("20260302"))).toBe(true);
    expect(ids.some((i) => i.includes("20260304"))).toBe(true);
    // Sunday 3/1 is in the horizon but the class does not meet on Sundays.
    expect(ids.some((i) => i.includes("20260301"))).toBe(false);
    // Friday falls outside the horizon; the next scheduling run picks it up.
    expect(ids.some((i) => i.includes("20260306"))).toBe(false);
  });

  it("uses a typed date trigger on the class-reminders Android channel", async () => {
    jest.setSystemTime(new Date(2026, 2, 1, 20, 0, 0)); // Sunday
    await scheduleClassReminders([makeClass()], {});
    expect(mockSchedule).toHaveBeenCalled();
    for (const call of mockSchedule.mock.calls) {
      expect(call[0].trigger).toEqual(
        expect.objectContaining({ type: "date", channelId: "class-reminders" }),
      );
      expect(call[0].trigger.date).toBeInstanceOf(Date);
    }
  });

  it("never schedules a trigger in the past", async () => {
    jest.setSystemTime(new Date(2026, 2, 2, 8, 55, 0)); // Monday 8:55, class at 9:00
    await scheduleClassReminders([makeClass()], {});

    const now = Date.now();
    for (const call of mockSchedule.mock.calls) {
      expect((call[0].trigger as { date: Date }).date.getTime()).toBeGreaterThan(now);
    }
    // Today's 20-min and 45-min reminders are past; Wednesday's are not.
    expect(scheduledIds().some((i) => i.includes("20260304"))).toBe(true);
  });

  it("does not schedule anything when OS permission is not granted", async () => {
    // The stored opt-in flag can disagree with the OS after the user revokes
    // notifications in Settings.
    mockGranted = false;
    jest.setSystemTime(new Date(2026, 2, 1, 20, 0, 0));
    await scheduleClassReminders([makeClass()], {});
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it("respects the iOS pending-notification budget", async () => {
    jest.setSystemTime(new Date(2026, 2, 1, 20, 0, 0));
    const many = Array.from({ length: 8 }, (_, i) =>
      makeClass({
        class_id: `c${i}`,
        title: `Class ${i}`,
        start_time_local: `${String(9 + i).padStart(2, "0")}:00`,
        days_of_week: ["MON", "TUE", "WED", "THU", "FRI"],
      }),
    );
    await scheduleClassReminders(many, {});
    expect(mockSchedule.mock.calls.length).toBeLessThanOrEqual(56);
  });

  it("schedules soonest-first so trimming drops the far end of the horizon", async () => {
    jest.setSystemTime(new Date(2026, 2, 1, 20, 0, 0));
    const many = Array.from({ length: 8 }, (_, i) =>
      makeClass({
        class_id: `c${i}`,
        start_time_local: `${String(9 + i).padStart(2, "0")}:00`,
        days_of_week: ["MON", "TUE", "WED", "THU", "FRI"],
      }),
    );
    await scheduleClassReminders(many, {});

    const times = mockSchedule.mock.calls.map((c) => (c[0].trigger as { date: Date }).date.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("does not derive a depart offset from an unstructured summary", async () => {
    // Regression: the old fallback took the smallest integer in the summary,
    // so "Bus 1 in 12 min" yielded a 1-minute ETA and fired "Leave now"
    // 3 minutes before class for a 12-minute trip.
    (getClassRouteData as jest.Mock).mockResolvedValue(null);
    (getClassSummary as jest.Mock).mockResolvedValue("Bus 1 in 12 min OR walk 20 min");
    jest.setSystemTime(new Date(2026, 2, 2, 7, 0, 0)); // Monday 7:00 AM

    await scheduleClassReminders([makeClass()], {});

    expect(scheduledIds().some((i) => i.startsWith("class-depart-"))).toBe(false);
  });

  it("uses structured route data for the depart alert when available", async () => {
    (getClassRouteData as jest.Mock).mockResolvedValue({
      summary: "Bus 22",
      bestDepartInMinutes: 30,
      etaMinutes: 25,
      options: [{ label: "Bus 22", departInMinutes: 30 }],
    });
    jest.setSystemTime(new Date(2026, 2, 2, 7, 0, 0)); // Monday 7:00 AM

    await scheduleClassReminders([makeClass()], {});

    expect(scheduledIds().some((i) => i.startsWith("class-depart-c1-20260302"))).toBe(true);
  });

  it("only trusts cached route data for today's occurrence", async () => {
    // Route data describes today's traffic and bus positions. Applying it to
    // Wednesday would arm a "Leave now" alert off a two-day-old ETA.
    (getClassRouteData as jest.Mock).mockResolvedValue({
      summary: "Bus 22",
      bestDepartInMinutes: 30,
      etaMinutes: 25,
      options: [{ label: "Bus 22", departInMinutes: 30 }],
    });
    jest.setSystemTime(new Date(2026, 2, 1, 20, 0, 0)); // Sunday: no class today

    await scheduleClassReminders([makeClass()], {});

    expect(getClassRouteData).not.toHaveBeenCalled();
    expect(getClassSummary).not.toHaveBeenCalled();
    expect(scheduledIds().some((i) => i.startsWith("class-depart-"))).toBe(false);
    expect(scheduledIds().some((i) => i.startsWith("class-c1-20260302"))).toBe(true);
  });

  it("suppresses the depart alert when it would collide with the 20-min reminder", async () => {
    // departOffset = 15 + 5 buffer = 20, identical to REMINDER_MINUTES_BEFORE:
    // two near-identical banners at the same instant.
    (getClassRouteData as jest.Mock).mockResolvedValue({
      summary: "Bus 22",
      bestDepartInMinutes: 15,
      etaMinutes: 12,
      options: [{ label: "Bus 22", departInMinutes: 15 }],
    });
    jest.setSystemTime(new Date(2026, 2, 2, 7, 0, 0));

    await scheduleClassReminders([makeClass()], {});

    expect(scheduledIds().some((i) => i.startsWith("class-depart-"))).toBe(false);
    expect(scheduledIds().some((i) => i.startsWith("class-c1-20260302"))).toBe(true);
  });

  it("suppresses the depart alert when it would precede the 45-min reminder", async () => {
    // departOffset = 50 + 5 buffer = 55 > EARLY_REMINDER_MINUTES_BEFORE:
    // "Leave now" would fire before the "in 45 minutes" heads-up.
    (getClassRouteData as jest.Mock).mockResolvedValue({
      summary: "Bus 22",
      bestDepartInMinutes: 50,
      etaMinutes: 45,
      options: [{ label: "Bus 22", departInMinutes: 50 }],
    });
    jest.setSystemTime(new Date(2026, 2, 2, 7, 0, 0));

    await scheduleClassReminders([makeClass()], {});

    expect(scheduledIds().some((i) => i.startsWith("class-depart-"))).toBe(false);
    expect(scheduledIds().some((i) => i.startsWith("class-early-c1-20260302"))).toBe(true);
  });

  it("skips muted classes on every day of the horizon", async () => {
    (getDisabledClassIds as jest.Mock).mockResolvedValue(["c1"]);
    jest.setSystemTime(new Date(2026, 2, 1, 20, 0, 0));

    await scheduleClassReminders([makeClass()], {});
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe("cancelClassReminder", () => {
  beforeEach(() => jest.clearAllMocks());

  it("cancels every namespaced occurrence for the class", async () => {
    mockGetAll.mockResolvedValue([
      { identifier: "class-c1-20260302" },
      { identifier: "class-early-c1-20260302" },
      { identifier: "class-depart-c1-20260304" },
      { identifier: "class-c2-20260302" }, // different class, must survive
      { identifier: "leave-now-c1" },      // different prefix, handled elsewhere
    ]);

    await cancelClassReminder("c1");

    const cancelled = mockCancel.mock.calls.map((c) => c[0]);
    expect(cancelled).toEqual([
      "class-c1-20260302",
      "class-early-c1-20260302",
      "class-depart-c1-20260304",
    ]);
    expect(cancelled).not.toContain("class-c2-20260302");
  });
});
