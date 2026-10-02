import type { ScheduleClass } from "@/src/api/types";
import { getClassSummary, getClassRouteData } from "@/src/storage/classSummaryCache";
import { getWalkedClassIdsToday } from "@/src/storage/walkedClassToday";
import { getDisabledClassIds } from "@/src/storage/classNotifPrefs";
import { getTodayCode } from "@/src/utils/nextClass";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const CLASS_REMINDER_PREFIX = "class-";
const CLASS_DEPART_PREFIX = "class-depart-";
const CLASS_EARLY_PREFIX = "class-early-";

export const MISS_CLASS_PREFIX = "miss_class_";
export const STOP_THRESHOLD_PREFIX = "stop_threshold_";
export const MORNING_DIGEST_PREFIX = "morning_digest_";
const DEEP_LINK_PATH = "/(tabs)?focus=recommendations";
const REMINDER_MINUTES_BEFORE = 20;
const EARLY_REMINDER_MINUTES_BEFORE = 45;

/**
 * How many days ahead to schedule.
 *
 * Reminders used to be scheduled for the current calendar day only, so a class
 * added on Sunday evening produced nothing for Monday morning: the trigger was
 * already in the past. Recovery depended on iOS background fetch, which never
 * runs after a force-quit. Scheduling a horizon up front removes that
 * dependency entirely.
 */
const SCHEDULE_HORIZON_DAYS = 5;

/**
 * iOS silently discards pending notifications past 64 per app, dropping the
 * LATEST-firing ones. Cap below that and keep headroom for leave-now alerts so
 * the far end of the week is trimmed deliberately rather than by the OS.
 */
const MAX_SCHEDULED = 56;

const DAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

/** Local YYYYMMDD, used to namespace identifiers per occurrence. */
function dateKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

/** Ensure we can present notifications when app is in foreground. */
export function setNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/** Android channel every class reminder posts to (ignored on iOS). */
const CHANNEL_ID = "class-reminders";

/** Create default channel for Android so scheduled notifications show. */
async function ensureChannel(): Promise<void> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Class reminders",
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: undefined,
    });
  }
}

/**
 * Request notification permission. Call when user first enables class notifications
 * (e.g. in Settings) or during onboarding.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  await ensureChannel();
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === "granted") return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

/** Get classes that occur today (by device local weekday). */
export function getTodayClasses(
  classes: ScheduleClass[],
  now: Date = new Date()
): ScheduleClass[] {
  const today = getTodayCode(now);
  return classes
    .filter((c) => c.days_of_week?.includes(today))
    .sort((a, b) => {
      const [ah, am] = a.start_time_local.split(":").map(Number);
      const [bh, bm] = b.start_time_local.split(":").map(Number);
      return (ah ?? 0) * 60 + (am ?? 0) - (bh ?? 0) * 60 - (bm ?? 0);
    });
}

/**
 * Format the clock time a user must leave by, given class start and depart offset.
 * e.g. startTimeLocal="14:30", departInMinutes=15 → "2:15 PM"
 */
function leaveByLabel(startTimeLocal: string, departInMinutes: number): string {
  const [h, m] = startTimeLocal.split(":").map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return "";
  const totalMinutes = h * 60 + m - departInMinutes;
  const leaveH = Math.floor(((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60) / 60);
  const leaveM = ((totalMinutes % 60) + 60) % 60;
  const period = leaveH < 12 ? "AM" : "PM";
  const displayH = leaveH % 12 === 0 ? 12 : leaveH % 12;
  const displayM = leaveM.toString().padStart(2, "0");
  return `${displayH}:${displayM} ${period}`;
}

/**
 * Build trigger Date for (class start - offsetMinutes) on `day`, in local time.
 * Returns null if that time is already past.
 *
 * `day` is the calendar date the class occurs on. Constructing the Date from
 * local Y/M/D fields keeps this correct across DST transitions.
 */
function triggerDateForClass(
  startTimeLocal: string,
  offsetMinutes: number,
  now: Date = new Date(),
  day: Date = now
): Date | null {
  const [h, m] = startTimeLocal.split(":").map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return null;
  const classStart = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    h,
    m,
    0,
    0
  );
  const trigger = new Date(classStart.getTime() - offsetMinutes * 60 * 1000);
  if (trigger.getTime() <= now.getTime()) return null;
  return trigger;
}

/**
 * Schedule local class reminders across the next SCHEDULE_HORIZON_DAYS days.
 *
 * Three notifications per class occurrence:
 *  1. 45 min before  — heads-up
 *  2. 20 min before  — with route summary and leave-by clock time
 *  3. "Leave now"    — timed from structured route data (no regex)
 *
 * Skips classes the user muted or already walked to today. Identifiers are
 * namespaced per occurrence date so a single day can be cancelled precisely.
 */
export async function scheduleClassReminders(
  classes: ScheduleClass[],
  buildingIdToName: Record<string, string> = {},
  walkingSpeedMps: number = 1.2,
  bufferMinutes: number = 5
): Promise<void> {
  // The stored opt-in flag can disagree with the OS (permission revoked in
  // Settings). Without this check we "schedule" reminders iOS silently drops,
  // and the Settings toggle keeps claiming reminders are on.
  const perms = await Notifications.getPermissionsAsync();
  if (!perms.granted) return;

  await ensureChannel();
  const now = new Date();
  const [walkedIds, disabledIds] = await Promise.all([
    getWalkedClassIdsToday(now),
    getDisabledClassIds(),
  ]);

  type Pending = {
    at: Date;
    identifier: string;
    title: string;
    body: string;
  };
  const pending: Pending[] = [];

  for (let dayOffset = 0; dayOffset < SCHEDULE_HORIZON_DAYS; dayOffset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    const dayCode = DAY_CODES[day.getDay()];
    const key = dateKey(day);

    const dayClasses = classes.filter((c) => c.days_of_week?.includes(dayCode));

    for (const c of dayClasses) {
      // Mute applies to every day; "already walked" is a today-only choice.
      if (disabledIds.includes(c.class_id)) continue;
      if (dayOffset === 0 && walkedIds.includes(c.class_id)) continue;

      const buildingName =
        (c.building_id === "custom" && c.destination_name)
          ? c.destination_name
          : (buildingIdToName[c.building_id] ?? c.building_id);

      // 45-minute early reminder
      const earlyTrigger = triggerDateForClass(
        c.start_time_local, EARLY_REMINDER_MINUTES_BEFORE, now, day
      );
      if (earlyTrigger) {
        pending.push({
          at: earlyTrigger,
          identifier: `${CLASS_EARLY_PREFIX}${c.class_id}-${key}`,
          title: `${c.title} in 45 minutes`,
          body: `Head to ${buildingName} soon. Open app for live route options.`,
        });
      }

      // 20-minute reminder (with route details)
      const triggerAt = triggerDateForClass(
        c.start_time_local, REMINDER_MINUTES_BEFORE, now, day
      );
      if (!triggerAt) continue;

      // Cached route data describes today's conditions, so only trust it for
      // today. Future days get the generic reminder rather than a stale ETA.
      const routeData = dayOffset === 0 ? await getClassRouteData(c.class_id) : null;
      let body: string;
      let departOffset: number | null = null;

      if (routeData) {
        const leaveBy = leaveByLabel(c.start_time_local, routeData.bestDepartInMinutes);
        const optionsList = routeData.options.map((o) => o.label).join(" or ");
        body = leaveBy
          ? `Leave by ${leaveBy} — ${optionsList}`
          : `${buildingName} · ${routeData.summary}`;
        departOffset = routeData.bestDepartInMinutes + bufferMinutes;
      } else {
        const summary = dayOffset === 0 ? await getClassSummary(c.class_id) : null;
        body = summary
          ? `${buildingName} · ${summary}`
          : `Next class at ${c.start_time_local} in ${buildingName}. Open for best route options.`;
        // Deliberately no depart offset here. The previous fallback parsed the
        // smallest integer out of the summary string, but summaries read
        // "Bus 1 in 12 min" — so route number 1 was mistaken for a 1-minute
        // ETA and "Leave now" fired 3 minutes before class for a 12-minute
        // trip. With no structured data there is no trustworthy offset.
      }

      pending.push({
        at: triggerAt,
        identifier: `${CLASS_REMINDER_PREFIX}${c.class_id}-${key}`,
        title: c.title,
        body,
      });

      // Second "Leave now" notification
      if (departOffset != null && departOffset > 0) {
        // Suppress when it would land on top of the 20-minute reminder, and
        // when it would precede the 45-minute one (an ordering inversion).
        const collidesWithReminder = Math.abs(departOffset - REMINDER_MINUTES_BEFORE) < 3;
        const precedesEarly = departOffset > EARLY_REMINDER_MINUTES_BEFORE;
        if (!collidesWithReminder && !precedesEarly) {
          const departTrigger = triggerDateForClass(
            c.start_time_local, departOffset, now, day
          );
          if (departTrigger) {
            pending.push({
              at: departTrigger,
              identifier: `${CLASS_DEPART_PREFIX}${c.class_id}-${key}`,
              title: `Leave now for ${c.title}`,
              body: routeData
                ? `Head out now — ${routeData.options.map((o) => o.label).join(" or ")}`
                : body,
            });
          }
        }
      }
    }
  }

  // Soonest first, then trim: iOS drops the latest-firing requests past its
  // limit, so trimming here keeps the imminent reminders and discards the
  // far end of the horizon, which the next run will re-create anyway.
  pending.sort((a, b) => a.at.getTime() - b.at.getTime());
  const toSchedule = pending.slice(0, MAX_SCHEDULED);

  for (const n of toSchedule) {
    await Notifications.scheduleNotificationAsync({
      identifier: n.identifier,
      content: {
        title: n.title,
        body: n.body,
        data: { url: DEEP_LINK_PATH },
      },
      // A bare Date is the deprecated trigger form (it logs a warning per
      // call) and can't carry the Android channel.
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: n.at,
        channelId: CHANNEL_ID,
      },
    });
  }
}

/** Cancel all scheduled notifications that are class reminders. */
export async function cancelAllClassReminders(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const req of scheduled) {
    if (
      req.identifier.startsWith(CLASS_REMINDER_PREFIX) ||
      req.identifier.startsWith(CLASS_DEPART_PREFIX) ||
      req.identifier.startsWith(CLASS_EARLY_PREFIX)
    ) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier);
    }
  }
}

/**
 * Cancel every scheduled reminder for one class across the whole horizon
 * (e.g. when user taps "I'm walking to this class" or deletes the class).
 *
 * Identifiers are namespaced per occurrence date, so this matches by prefix
 * rather than cancelling three fixed ids.
 */
export async function cancelClassReminder(classId: string): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const prefixes = [CLASS_EARLY_PREFIX, CLASS_REMINDER_PREFIX, CLASS_DEPART_PREFIX];
  for (const req of scheduled) {
    // Exact match covers legacy un-dated ids; the "-" delimiter stops a
    // class_id that is a prefix of another (c1 vs c10) from cancelling both.
    if (prefixes.some((p) => req.identifier === `${p}${classId}` || req.identifier.startsWith(`${p}${classId}-`))) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier);
    }
  }
}

/**
 * Fire immediately when no bus can get the user to class on time.
 * Identifier: MISS_CLASS_PREFIX + classId
 */
export async function scheduleMissClassAlert(
  classId: string,
  classTitle: string,
  walkMins: number
): Promise<void> {
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    identifier: `${MISS_CLASS_PREFIX}${classId}`,
    content: {
      title: "You might miss class",
      body: `No bus gets you to ${classTitle} on time — walk is ${walkMins} min`,
      data: { url: DEEP_LINK_PATH },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 1,
      channelId: CHANNEL_ID,
    },
  });
}

/**
 * Fire immediately when a favorited stop's bus is N minutes away.
 * Cancels any existing notification for the same stop+route before scheduling.
 * Identifier: STOP_THRESHOLD_PREFIX + stopId + "_" + routeId
 */
export async function scheduleStopThresholdAlert(
  stopId: string,
  stopName: string,
  routeId: string,
  minsAway: number
): Promise<void> {
  await ensureChannel();
  const identifier = `${STOP_THRESHOLD_PREFIX}${stopId}_${routeId}`;
  // Cancel existing before rescheduling
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: `Route ${routeId} approaching`,
      body: `${routeId} arriving at ${stopName} in ${minsAway} min`,
      data: { url: DEEP_LINK_PATH },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 1,
      channelId: CHANNEL_ID,
    },
  });
}

/**
 * Schedule a morning digest notification at a specific Date.
 * Identifier: MORNING_DIGEST_PREFIX + classId
 */
export async function scheduleMorningDigest(
  classId: string,
  classTitle: string,
  firstDepartTime: string,
  digestTime: Date
): Promise<void> {
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    identifier: `${MORNING_DIGEST_PREFIX}${classId}`,
    content: {
      title: "Good morning — class day",
      body: `${classTitle} starts soon. Leave by ${firstDepartTime} for your best route.`,
      data: { url: DEEP_LINK_PATH },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: digestTime,
      channelId: CHANNEL_ID,
    },
  });
}

/** Schedule a one-off test notification in 3 seconds. Use for "Send test notification" in Settings. */
export async function sendTestNotification(): Promise<void> {
  await ensureChannel();
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") {
    const { status: requested } = await Notifications.requestPermissionsAsync();
    if (requested !== "granted") throw new Error("Notification permission denied.");
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "UIUC Bus",
      body: "Test notification — if you see this, reminders will work for your classes.",
      data: {},
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 3, channelId: CHANNEL_ID },
  });
}
