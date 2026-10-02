/**
 * widgetRefresh.ts
 *
 * Assembles the WidgetData snapshot from cached storage and writes it
 * to the shared file so the iOS widget extension can read fresh data.
 *
 * Called:
 *   1. App comes to foreground (AppState 'active')
 *   2. Every background fetch cycle (inside notificationRefresh task)
 */

import { dateStringForOffset, getActivityForDate, getActivityLog, getWeeklyStepGoal, todayDateString } from '@/src/storage/activityLog';
import { getLastKnownHomeData } from '@/src/storage/lastKnownHome';
import { getStoredApiKey } from '@/src/storage/apiKey';
import { getStoredApiBaseUrl } from '@/src/storage/apiUrl';
import { getStoredBufferMinutes, getStoredWalkingMode } from '@/src/storage/recommendationSettings';
import { getMpsForMode } from '@/src/constants/walkingMode';
import { fetchRecommendation, fetchClasses } from '@/src/api/client';
import { arriveByIsoToday } from '@/src/utils/arriveBy';
import { getNextClassToday, getTodayCode } from '@/src/utils/nextClass';
import type { ScheduleClass } from '@/src/api/types';
import { writeWidgetData, type WidgetData, type WidgetTodayClass } from '@/src/utils/widgetDataWriter';
import { clockTimeAfter, clockTimeBefore, minutesUntilBefore, padTime } from '@/src/utils/leaveTime';

export async function refreshWidgetData(): Promise<void> {
  try {
    const [apiBaseUrl, apiKey, walkingModeId, bufferMinutes, lastKnown, weeklyGoal] = await Promise.all([
      getStoredApiBaseUrl(),
      getStoredApiKey(),
      getStoredWalkingMode(),
      getStoredBufferMinutes(),
      getLastKnownHomeData(),
      getWeeklyStepGoal(),
    ]);

    const walkingSpeedMps = getMpsForMode(walkingModeId);

    // Steps
    const today = todayDateString();
    const [todayEntries, fullLog] = await Promise.all([
      getActivityForDate(today),
      getActivityLog(),
    ]);
    const stepsToday = todayEntries.reduce((s, e) => s + e.stepCount, 0);
    // Last 7 calendar days including today. YYYY-MM-DD strings compare in
    // date order; comparing against "now minus 6 days" kept the time of day
    // and silently dropped the oldest day.
    const weekStart = dateStringForOffset(6);
    const weeklySteps = fullLog
      .filter((e) => e.date >= weekStart)
      .reduce((s, e) => s + e.stepCount, 0);

    // Classes
    let classes: ScheduleClass[] = lastKnown?.scheduleClasses ?? [];
    if (!classes.length) {
      try {
        const res = await fetchClasses(apiBaseUrl, { apiKey: apiKey ?? undefined });
        classes = res.classes ?? [];
      } catch {}
    }

    const now = new Date();
    const nextClass = getNextClassToday(classes, now);

    // Today's class list (all classes today, sorted by start time)
    const today_day = getTodayCode(now);
    const todayClasses = classes
      .filter((c) => c.days_of_week.includes(today_day))
      .sort((a, b) => a.start_time_local.localeCompare(b.start_time_local));

    // Build today class entries with recommended depart times (use 15min estimate if no route data)
    const todayClassEntries: WidgetTodayClass[] = todayClasses.map((c) => ({
      name: c.title,
      startTime: c.start_time_local,
      building: c.destination_name ?? c.building_id,
      recommendedDepartTime: clockTimeBefore(c.start_time_local, 15),
    }));

    let widgetNextClass: WidgetData['nextClass'] = null;
    let widgetNextBus: WidgetData['nextBus'] = null;

    if (nextClass) {
      const loc = lastKnown?.location ?? { lat: 40.102, lng: -88.2272 };
      try {
        const hasCustomDest =
          nextClass.destination_lat != null && nextClass.destination_lng != null;
        const rec = await fetchRecommendation(
          apiBaseUrl,
          {
            lat: loc.lat,
            lng: loc.lng,
            ...(hasCustomDest
              ? {
                  destination_lat: nextClass.destination_lat!,
                  destination_lng: nextClass.destination_lng!,
                  destination_name: nextClass.destination_name ?? 'Class',
                }
              : { destination_building_id: nextClass.building_id }),
            arrive_by_iso: arriveByIsoToday(nextClass.start_time_local),
            walking_speed_mps: walkingSpeedMps,
            buffer_minutes: bufferMinutes,
            max_options: 2,
          },
          { apiKey: apiKey ?? undefined }
        );

        const bestOpt = rec.options?.[0];
        if (bestOpt) {
          // depart_in_minutes counts from now, not back from the class start.
          widgetNextClass = {
            name: nextClass.title,
            startTime: nextClass.start_time_local,
            building: nextClass.destination_name ?? nextClass.building_id,
            leaveByTime: clockTimeAfter(now, bestOpt.depart_in_minutes),
            leaveInMinutes: Math.max(0, Math.round(bestOpt.depart_in_minutes)),
          };

          const rideStep = bestOpt.steps.find((s) => s.type === 'RIDE');
          const walkStep = bestOpt.steps.find((s) => s.type === 'WALK_TO_STOP');
          if (rideStep) {
            const deptEpoch = Date.now() + bestOpt.depart_in_minutes * 60 * 1000;
            const dh = new Date(deptEpoch).getHours();
            const dm = new Date(deptEpoch).getMinutes();
            widgetNextBus = {
              route: rideStep.route ?? '',
              stop: walkStep?.stop_name ?? rideStep.stop_name ?? '',
              departureTime: padTime(dh, dm),
              minsUntil: Math.max(0, Math.round(bestOpt.depart_in_minutes)),
              isLive: true,
            };
          }
        }
      } catch {
        // No route data — still show class without bus info
        widgetNextClass = {
          name: nextClass.title,
          startTime: nextClass.start_time_local,
          building: nextClass.destination_name ?? nextClass.building_id,
          leaveByTime: clockTimeBefore(nextClass.start_time_local, 15),
          leaveInMinutes: minutesUntilBefore(nextClass.start_time_local, 15, now),
        };
      }
    }

    const payload: WidgetData = {
      nextClass: widgetNextClass,
      nextBus: widgetNextBus,
      todayClasses: todayClassEntries,
      stepsToday,
      weeklyStepGoal: weeklyGoal,
      weeklyStepsProgress: Math.min(1, weeklySteps / weeklyGoal),
      lastUpdated: Date.now(),
      isDataFresh: true,
    };

    await writeWidgetData(payload);
  } catch {
    // Non-fatal
  }
}
