/**
 * leaveNow.ts
 * Schedules a single "Leave Now" push notification that fires exactly when
 * the user must leave to catch the best route option.
 *
 * Separate from classReminders.ts (20-min / 45-min windows).
 * Every call is idempotent: cancels the previous notification before scheduling.
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { RecommendationOption, RecommendationStep } from "@/src/api/types";

const LEAVE_NOW_PREFIX = "leave-now-";
const DEEP_LINK_PATH = "/(tabs)?focus=recommendations";

const CHANNEL_ID = "leave-now-alerts";

async function ensureLeaveNowChannel(): Promise<void> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Leave Now alerts",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
}

/** Build notification title + body from a recommendation option. */
export function buildLeaveNowBody(
  option: RecommendationOption,
  classTitle: string
): { title: string; body: string } {
  const title = `Leave now for ${classTitle}`;

  if (option.type === "WALK") {
    return { title, body: `Walk ${Math.round(option.eta_minutes)} min to class` };
  }

  const walkStep = option.steps.find((s: RecommendationStep) => s.type === "WALK_TO_STOP");
  const rideStep = option.steps.find((s: RecommendationStep) => s.type === "RIDE");
  const route = rideStep?.route ?? "";
  const stopName = walkStep?.stop_name ?? "";
  const headsign = rideStep?.headsign ?? "";

  let body: string;
  if (route && stopName) {
    body = `Catch Bus ${route} at ${stopName}`;
    if (headsign) body += ` → ${headsign}`;
  } else if (route) {
    body = `Catch Bus ${route} · ${Math.round(option.eta_minutes)} min total`;
  } else {
    body = `${Math.round(option.eta_minutes)} min total trip`;
  }

  return { title, body };
}

/**
 * Schedule a "Leave Now" notification that fires in `option.depart_in_minutes` minutes.
 * Cancels any previously scheduled notification for this class first.
 */
export async function scheduleLeaveNowAlert(
  classId: string,
  classTitle: string,
  option: RecommendationOption
): Promise<void> {
  await ensureLeaveNowChannel();
  await cancelLeaveNowAlert(classId);

  if (option.depart_in_minutes <= 0) return;

  const secondsFromNow = Math.max(10, Math.round(option.depart_in_minutes * 60));
  const { title, body } = buildLeaveNowBody(option, classTitle);

  await Notifications.scheduleNotificationAsync({
    identifier: `${LEAVE_NOW_PREFIX}${classId}`,
    content: {
      title,
      body,
      data: { url: DEEP_LINK_PATH, classId },
      sound: "default",
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: secondsFromNow,
      repeats: false,
      // Without this Android posts to the default channel and the HIGH
      // importance / vibration configured above never applies.
      channelId: CHANNEL_ID,
    },
  });
}

/** Cancel the leave-now notification for one class. */
export async function cancelLeaveNowAlert(classId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(`${LEAVE_NOW_PREFIX}${classId}`);
}

/** Cancel all leave-now notifications. */
export async function cancelAllLeaveNowAlerts(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((n) => n.identifier.startsWith(LEAVE_NOW_PREFIX))
      .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
  );
}
