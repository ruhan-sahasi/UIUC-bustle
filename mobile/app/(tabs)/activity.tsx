import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchEodReport } from "@/src/api/client";
import { formatDistance } from "@/src/utils/distance";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { getPendingAutoWalk, clearPendingAutoWalk } from "@/src/utils/autoWalkDetect";
import { type ActivityEntry, addActivityEntry, calcStreak, dateStringForOffset, getActivityForDate, getActivityLog, todayDateString, WEEKLY_STEP_GOAL, getWeeklyStepGoal, setWeeklyStepGoal } from "@/src/storage/activityLog";
import { computeAllInsights, getDismissedInsights, dismissInsight, type PatternInsights } from "@/src/utils/patternEngine";
import PatternInsightCards from "@/src/components/PatternInsightCards";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AlertCircle, Check, Flame, Footprints, MapPin, Pencil, PiggyBank, ShieldCheck, Sparkles, TrendingUp } from "lucide-react-native";
import { STAGGER } from "@/src/constants/motion";
import { theme } from "@/src/constants/theme";
import { Button } from "@/src/components/ui/Button";
import { EmptyState } from "@/src/components/ui/EmptyState";
import { AreaSpark, BarRow, RingGauge, type BarDatum } from "@/src/components/ui/Charts";
import {
  AnimatedNumber,
  FadeInView,
  fireHaptic,
  Odometer,
  PressableScale,
  PulseView,
  Skeleton,
  Stagger,
} from "@/src/components/ui/motion";

const CHART_DAYS = 7;
/** Plot height of the week chart, px. The label row sits below it. */
const BAR_MAX_H = 80;
/** Bar geometry, sized so seven "Today"-width ticks fit a card at 375pt. */
const BAR_W = 34;
const BAR_GAP = theme.spacing.sm;
/** Height of the hero trend spark, px. Fixed so the card never reflows. */
const TREND_H = 44;

/**
 * Card entrance schedule, on the shared stagger tokens rather than hand-picked
 * milliseconds. The cap is what keeps a long sequence honest.
 */
const cardDelay = (i: number) => Math.min(i, STAGGER.cap) * STAGGER.step;

/** Digit columns needed to show a non-negative integer with no dead padding. */
function placesFor(n: number): number {
  return Math.max(1, Math.floor(Math.max(n, 0)).toString().length);
}

/**
 * Compact step count for the value row under each bar. A 34px cell cannot hold
 * "12,481" without ellipsizing, and a truncated number is worse than a rounded
 * one. Zero days stay blank — an axis of "0"s is noise, not information.
 *
 * Display only: the chart's spoken summary is passed to `BarRow` explicitly and
 * carries the exact, fully-grouped counts.
 */
function compactSteps(v: number): string {
  if (!(v > 0)) return "";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
}

interface DaySummary {
  date: string;
  label: string;
  steps: number;
  calories: number;
  distanceM: number;
  durationSeconds: number;
}

function shortDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] ?? dateStr.slice(-2);
}

const AI_DISCLOSURE_KEY = '@uiuc_bus_ai_report_consented';

// ── Render-only pieces ─────────────────────────────────────────────────────

/**
 * One stat cell on the navy hero — rolling tabular digits over a quiet label.
 *
 * `AnimatedNumber` brings the tabular figures with it, so the column never
 * jitters as a digit swaps. `unit` is the spoken form of the abbreviation:
 * VoiceOver should say "412 calories", not "412 kcal".
 */
function HeroStat({ value, label, unit }: { value: string; label: string; unit?: string }) {
  return (
    <View style={styles.statCell}>
      <AnimatedNumber
        value={value}
        style={styles.statValue}
        accessibilityLabel={`${value} ${unit ?? label}`}
      />
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/**
 * The week's step trend as a filled sparkline.
 *
 * The series is the SAME `weekSummaries` the bar chart reads — nothing is
 * fetched and nothing is recomputed here, it is a second view of one dataset.
 * `AreaSpark` needs a concrete px width, so this wrapper measures itself once;
 * keeping that state here rather than on the screen leaves the screen's hook
 * order untouched. The memo matters: a fresh `values` array on every render
 * would restart the mask wipe each time the screen re-renders.
 */
function StepsTrend({ days }: { days: DaySummary[] }) {
  const [width, setWidth] = useState(0);
  const values = useMemo(() => days.map((d) => d.steps), [days]);

  return (
    <View
      style={styles.trendWrap}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 && (
        <AreaSpark
          values={values}
          width={width}
          height={TREND_H}
          color={theme.colors.orangeBright}
          fill={[theme.colors.orangeBright, theme.colors.orange]}
          dotColor={theme.colors.orangeBright}
          strokeWidth={2.5}
          delay={cardDelay(2)}
          accessibilityLabel="Step trend over the last 7 days"
        />
      )}
    </View>
  );
}

interface LapRingProps {
  /** Whole percent of the weekly goal — the screen's audited value, not recomputed. */
  pct: number;
  /** Clamped 0..1 progress, used for the ordinary sub-goal sweep. */
  progress: number;
  goal: number;
}

/**
 * The weekly goal as a lapping ring.
 *
 * `RingGauge` with `laps` does the thing the hand-rolled ring could only fake:
 * past 100% the stroke starts a SECOND revolution in a different color instead
 * of pinning at full, so 118% reads as "a full lap plus a bit" rather than
 * identically to a week that just barely made it.
 *
 * The fraction fed to the gauge is derived from the screen's own audited
 * values, exactly as before — `progress` (min(1, steps / goal)) below the goal,
 * the rounded percent only for the overflow lap. Over-goal is never signalled
 * by color alone: the digits say 118% and a checked "Goal met" line sits
 * directly under them, which is also why the gauge's own `overLabel` is
 * suppressed — it would say the same thing twice.
 */
function LapRing({ pct, progress, goal }: LapRingProps) {
  const safePct = Math.max(pct, 0);
  // "Goal met" is a factual claim, so it comes from the exact clamped progress,
  // never from the rounded percent. `weeklyPct` rounds, so 99.5% displays as
  // "100%" — deriving the badge from that would put a checkmark and "Goal met"
  // on a week that is 250 steps short. `progress` is min(1, steps / goal), so
  // `progress >= 1` is true exactly when the goal was actually reached.
  const metGoal = progress >= 1;
  // Only the overflow lap is derived from the rounded percent; the ordinary
  // case keeps using the exact clamped progress the screen already computed.
  const sweep = metGoal ? safePct / 100 : progress;
  return (
    <RingGauge
      progress={sweep}
      laps
      size={116}
      strokeWidth={11}
      trackColor={theme.colors.borderSoft}
      colors={[theme.colors.orangeBright, theme.colors.orange]}
      lapColors={[theme.colors.gold, theme.colors.successDeep]}
      overLabel={null}
      accessibilityLabel={
        metGoal
          ? `${safePct} percent of weekly step goal, goal met`
          : `${safePct} percent of weekly step goal`
      }
    >
      <AnimatedNumber value={`${safePct}%`} style={styles.weeklyPctBig} />
      {metGoal ? (
        <View style={styles.weeklyMetRow}>
          <Check size={11} color={theme.colors.successDeep} strokeWidth={3} />
          <Text style={styles.weeklyMetText}>Goal met</Text>
        </View>
      ) : (
        <Text style={styles.weeklyPctSub}>of {goal.toLocaleString()}</Text>
      )}
    </RingGauge>
  );
}

/** Auto-detected walk prompt, styled as a proper banner with real buttons. */
function AutoWalkBanner({ distanceM, minutes, onConfirm, onDismiss }: {
  distanceM: number;
  minutes: number;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <View style={styles.bannerIconHalo}>
        <Footprints size={19} color={theme.colors.brandInk} strokeWidth={2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle}>Looks like you walked</Text>
        <Text style={styles.bannerBody}>{formatDistance(distanceM)} · ~{minutes} min</Text>
        <View style={styles.bannerActions}>
          <Button label="Log it" size="sm" onPress={onConfirm} />
          <Button label="Not me" size="sm" variant="ghost" onPress={onDismiss} />
        </View>
      </View>
    </View>
  );
}

export default function ActivityScreen() {
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const [todayEntries, setTodayEntries] = useState<ActivityEntry[]>([]);
  const [weekSummaries, setWeekSummaries] = useState<DaySummary[]>([]);
  const [streak, setStreak] = useState(0);
  const [weeklySteps, setWeeklySteps] = useState(0);
  const [weeklyWalks, setWeeklyWalks] = useState(0);
  const [weeklyDistanceM, setWeeklyDistanceM] = useState(0);
  const [topDestination, setTopDestination] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reportError, setReportError] = useState<string | null>(null);
  const {
    mutate: generateReport,
    isPending: reportLoading,
    data: reportData,
  } = useMutation({
    mutationFn: (payload: Parameters<typeof fetchEodReport>[1]) =>
      fetchEodReport(apiBaseUrl, payload, { apiKey: apiKey ?? undefined }),
  });
  const reportText = reportData?.report ?? null;
  const [pendingWalk, setPendingWalk] = useState<any>(null);
  const [patternInsights, setPatternInsights] = useState<PatternInsights | null>(null);
  const [dismissedInsightKeys, setDismissedInsightKeys] = useState<string[]>([]);
  const [showAiDisclosure, setShowAiDisclosure] = useState(false);
  const [weeklyGoal, setWeeklyGoalState] = useState(WEEKLY_STEP_GOAL);

  const loadData = useCallback(async () => {
    const today = todayDateString();
    const todayData = await getActivityForDate(today);
    setTodayEntries(todayData);

    const log = await getActivityLog();
    const summaries: DaySummary[] = [];
    let totalWeekSteps = 0;
    for (let i = CHART_DAYS - 1; i >= 0; i--) {
      const dateStr = dateStringForOffset(i);
      const dayEntries = log.filter((e) => e.date === dateStr);
      const daySteps = dayEntries.reduce((s, e) => s + e.stepCount, 0);
      totalWeekSteps += daySteps;
      summaries.push({
        date: dateStr,
        label: i === 0 ? "Today" : shortDayLabel(dateStr),
        steps: daySteps,
        calories: Math.round(dayEntries.reduce((s, e) => s + e.caloriesBurned, 0) * 10) / 10,
        distanceM: dayEntries.reduce((s, e) => s + e.distanceM, 0),
        durationSeconds: dayEntries.reduce((s, e) => s + e.durationSeconds, 0),
      });
    }
    setWeekSummaries(summaries);
    setStreak(calcStreak(log));
    setWeeklySteps(totalWeekSteps);

    // Commute stats: last 7 days entries
    const weekEntries = log.filter((e) => {
      const d = new Date(e.date + "T12:00:00");
      const cutoff = new Date();
      // Window of 7 calendar days (today + 6 prior), matching the 7-day chart above.
      cutoff.setDate(cutoff.getDate() - 6);
      cutoff.setHours(0, 0, 0, 0);
      return d >= cutoff;
    });
    setWeeklyWalks(weekEntries.length);
    setWeeklyDistanceM(weekEntries.reduce((s, e) => s + e.distanceM, 0));
    const destCounts: Record<string, number> = {};
    for (const e of weekEntries) {
      const dest = e.to.split(",")[0].trim();
      if (dest) destCounts[dest] = (destCounts[dest] ?? 0) + 1;
    }
    const topDest = Object.entries(destCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    setTopDestination(topDest);
    setLoading(false);
    setRefreshing(false);

    const goal = await getWeeklyStepGoal();
    setWeeklyGoalState(goal);

    const pending = await getPendingAutoWalk();
    setPendingWalk(pending);

    const [insights, dismissed] = await Promise.all([
      computeAllInsights(),
      getDismissedInsights(),
    ]);
    setPatternInsights(insights);
    setDismissedInsightKeys(dismissed);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
  }, [loadData]);

  const doGetReport = useCallback(() => {
    setShowAiDisclosure(false);
    setReportError(null);
    const payload = {
      entries: todayEntries,
      total_steps: todayEntries.reduce((s, e) => s + e.stepCount, 0),
      total_calories: todayEntries.reduce((s, e) => s + e.caloriesBurned, 0),
      total_distance_m: todayEntries.reduce((s, e) => s + e.distanceM, 0),
    };
    generateReport(payload, {
      onSuccess: () => {
        fireHaptic("arrive");
      },
      onError: (e) => {
        setReportError(e instanceof Error ? e.message : "Failed to get report.");
      },
    });
  }, [todayEntries, generateReport]);

  const onGetReport = useCallback(async () => {
    const consented = await AsyncStorage.getItem(AI_DISCLOSURE_KEY);
    if (!consented) {
      setShowAiDisclosure(true);
    } else {
      doGetReport();
    }
  }, [doGetReport]);

  const onConfirmAutoWalk = useCallback(async () => {
    if (!pendingWalk) return;
    const durationS = (pendingWalk.endEpochMs - pendingWalk.startEpochMs) / 1000;
    await addActivityEntry({
      date: todayDateString(),
      walkingModeId: 'walk',
      distanceM: pendingWalk.distanceM,
      durationSeconds: durationS,
      stepCount: pendingWalk.stepCount,
      caloriesBurned: Math.round((durationS / 3600) * 3.5 * 70 * 10) / 10, // MET(3.5) × 70kg × hours
      from: 'Auto-detected',
      to: 'Auto-detected',
    });
    await clearPendingAutoWalk();
    setPendingWalk(null);
    loadData();
  }, [pendingWalk, loadData]);

  const onDismissAutoWalk = useCallback(async () => {
    await clearPendingAutoWalk();
    setPendingWalk(null);
  }, []);

  const handleDismissInsight = useCallback(async (key: string) => {
    await dismissInsight(key);
    loadData();
  }, [loadData]);

  const todaySteps = todayEntries.reduce((s, e) => s + e.stepCount, 0);
  const todayCalories = todayEntries.reduce((s, e) => s + e.caloriesBurned, 0);
  const todayDistanceM = todayEntries.reduce((s, e) => s + e.distanceM, 0);
  const todayDurationSeconds = todayEntries.reduce((s, e) => s + e.durationSeconds, 0);

  const weeklyProgress = Math.min(1, Math.max(0, weeklySteps / weeklyGoal));

  // The daily goal is the chart's reference line AND its scale floor. The floor
  // now lives inside `BarRow` (which maxes the axis against `goal`), so the
  // hand-computed chart max and goal-line offset are gone with the local chart.
  const dailyGoal = Math.max(1, Math.round(weeklyGoal / CHART_DAYS));
  const weeklyPct = Math.round((weeklySteps / weeklyGoal) * 100);

  if (loading) {
    // Skeletons shaped like the screen that is coming: hero card, the
    // goal + streak pair, then the week chart. Explicit sizes so the layout
    // doesn't shift when the real cards land.
    return (
      <View style={styles.loadingWrap}>
        <Skeleton height={236} radius={theme.radius.xxl} />
        <View style={styles.loadingRow}>
          <View style={styles.streakSlotWide}>
            <Skeleton height={176} radius={theme.radius.xl} />
          </View>
          <View style={styles.streakSlot}>
            <Skeleton height={176} radius={theme.radius.xl} />
          </View>
        </View>
        <Skeleton height={148} radius={theme.radius.xl} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.navy} />}
    >
      {/* Auto-walk banner */}
      {pendingWalk != null && (
        <FadeInView delay={0}>
          <AutoWalkBanner
            distanceM={pendingWalk.distanceM}
            minutes={Math.round((pendingWalk.endEpochMs - pendingWalk.startEpochMs) / 60000)}
            onConfirm={onConfirmAutoWalk}
            onDismiss={onDismissAutoWalk}
          />
        </FadeInView>
      )}

      {/* Today hero — navy departure-board card */}
      <FadeInView delay={0}>
        <LinearGradient
          colors={[theme.gradients.hero[0], theme.gradients.hero[1], theme.gradients.hero[2]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.todayCard}
        >
          <Text style={styles.todayEyebrow}>Today</Text>
          <AnimatedNumber
            value={todaySteps.toLocaleString()}
            style={styles.todayHeroValue}
            accessibilityLabel={`${todaySteps.toLocaleString()} steps today`}
          />
          <Text style={styles.todayHeroLabel}>steps</Text>
          {/* The week's real trend, not the decorative squiggle that stood here
              while Charts.tsx was missing. Same series as the bar chart. */}
          <StepsTrend days={weekSummaries} />
          <View style={styles.todayStats}>
            <HeroStat value={todayCalories.toFixed(0)} label="kcal" unit="calories" />
            <View style={styles.statDivider} />
            <HeroStat value={(todayDistanceM / 1609.344).toFixed(2)} label="mi" unit="miles" />
            <View style={styles.statDivider} />
            <HeroStat value={String(Math.floor(todayDurationSeconds / 60))} label="min" unit="minutes" />
          </View>
        </LinearGradient>
      </FadeInView>

      {/* Streak + weekly goal — the two cards enter in sequence, not together */}
      <View style={styles.streakRow}>
        <FadeInView delay={cardDelay(1)} style={styles.streakSlotWide}>
          <View style={styles.weeklyCard}>
            <View style={styles.weeklyHeader}>
              <Text style={styles.weeklyLabel}>Weekly goal</Text>
              <PressableScale
                haptic={false}
                hitSlop={8}
                style={styles.weeklyEditBtn}
                accessibilityRole="button"
                accessibilityLabel={`Edit weekly step goal, currently ${weeklySteps.toLocaleString()} of ${weeklyGoal.toLocaleString()} steps`}
                onPress={() => {
                Alert.prompt(
                  'Weekly step goal',
                  'Enter your weekly step goal',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Save',
                      onPress: async (val?: string) => {
                        const n = parseInt(val ?? '', 10);
                        if (!isNaN(n) && n >= 1000) {
                          await setWeeklyStepGoal(n);
                          setWeeklyGoalState(n);
                        }
                      },
                    },
                  ],
                  'plain-text',
                  String(weeklyGoal)
                );
              }}>
                <Pencil size={11} color={theme.colors.brandInk} strokeWidth={2.2} />
                <Text style={styles.weeklyFraction}>
                  {weeklySteps.toLocaleString()} / {weeklyGoal.toLocaleString()}
                </Text>
              </PressableScale>
            </View>
            <View style={styles.weeklyRingWrap}>
              <LapRing pct={weeklyPct} progress={weeklyProgress} goal={weeklyGoal} />
            </View>
          </View>
        </FadeInView>
        <FadeInView delay={cardDelay(2)} style={styles.streakSlot}>
          <LinearGradient
            colors={[theme.gradients.ember[0], theme.gradients.ember[1]]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.streakCard}
          >
            <PulseView minOpacity={0.75} maxScale={1.08} duration={1400} style={styles.streakFlame}>
              <Flame size={26} color={theme.colors.orangeBright} fill={theme.colors.orange} />
            </PulseView>
            <Odometer
              value={streak}
              places={placesFor(streak)}
              style={styles.streakCount}
              accessibilityLabel={`${streak} ${streak === 1 ? "day" : "days"} streak`}
            />
            <Text style={styles.streakLabel}>{streak === 1 ? "day streak" : "days streak"}</Text>
            <Text style={styles.streakHint}>{streak === 0 ? 'Walk today to start' : streak < 7 ? `${7 - streak} days to a week streak!` : 'Week streak!'}</Text>
          </LinearGradient>
        </FadeInView>
      </View>

      {/* Personalized goal suggestion */}
      {weeklySteps > weeklyGoal * 1.1 && (
        <FadeInView delay={110} style={styles.goalSuggestion}>
          <TrendingUp size={16} color={theme.colors.successDeep} />
          <Text style={styles.goalSuggestionText}>
            You're consistently exceeding your goal — consider raising it to {Math.ceil(weeklySteps * 1.1 / 1000) * 1000} steps/week
          </Text>
        </FadeInView>
      )}

      {/* 7-day bar chart (steps) */}
      <FadeInView delay={140} style={styles.chartCard}>
        <View style={styles.chartHeader}>
          <Text style={styles.chartTitle} accessibilityRole="header">Steps · last 7 days</Text>
        </View>
        {/* Rendering only: `weekSummaries` is the audited 7-day window, mapped
            straight to bars. `goal` also floors BarRow's y-axis at the daily
            goal, which is the same scale the screen drew before — a week of
            40-step days must not look like a week of 12,000-step days. */}
        <BarRow
          data={weekSummaries.map<BarDatum>((d) => ({
            value: d.steps,
            label: d.label,
            highlight: d.label === "Today",
          }))}
          height={BAR_MAX_H}
          barWidth={BAR_W}
          gap={BAR_GAP}
          radius={7}
          gradient={[theme.colors.navyLight, theme.colors.navy]}
          highlightColor={theme.colors.orange}
          goal={dailyGoal}
          goalLabel={`Goal ${dailyGoal.toLocaleString()}/day`}
          showValues
          formatValue={compactSteps}
          accessibilityLabel={`Steps, last 7 days. ${weekSummaries
            .map((d) => `${d.label}, ${d.steps.toLocaleString()}`)
            .join("; ")}. Daily goal ${dailyGoal.toLocaleString()} steps.`}
          style={styles.chartPlot}
        />
      </FadeInView>

      {/* Weekly commute summary */}
      {weeklyWalks > 0 && (
        <FadeInView delay={210} style={styles.commuteSummaryCard}>
          <Text style={styles.commuteSummaryTitle} accessibilityRole="header">7-day commute summary</Text>
          <View style={styles.commuteSummaryRow}>
            <View style={styles.commuteStat}>
              <Odometer
                value={weeklyWalks}
                places={placesFor(weeklyWalks)}
                style={styles.commuteStatValue}
                accessibilityLabel={`${weeklyWalks} walks`}
              />
              <Text style={styles.commuteStatLabel}>walks</Text>
            </View>
            <View style={styles.commuteStat}>
              <AnimatedNumber
                value={(weeklyDistanceM / 1609.344).toFixed(1)}
                style={styles.commuteStatValue}
                accessibilityLabel={`${(weeklyDistanceM / 1609.344).toFixed(1)} miles total`}
              />
              <Text style={styles.commuteStatLabel}>mi total</Text>
            </View>
            <View style={styles.commuteStat}>
              <AnimatedNumber
                value={(weeklyDistanceM / Math.max(weeklyWalks, 1) / 1609.344).toFixed(1)}
                style={styles.commuteStatValue}
                accessibilityLabel={`${(weeklyDistanceM / Math.max(weeklyWalks, 1) / 1609.344).toFixed(1)} miles average`}
              />
              <Text style={styles.commuteStatLabel}>mi avg</Text>
            </View>
          </View>
          {topDestination && (
            <View style={styles.commuteTopDest}>
              <MapPin size={12} color={theme.colors.textSecondary} />
              <Text style={styles.commuteTopDestText}>Most frequent: {topDestination}</Text>
            </View>
          )}
        </FadeInView>
      )}

      {/* Money saved */}
      {weeklyWalks > 0 && (
        <FadeInView delay={280} style={styles.moneySavedCard}>
          <View style={styles.moneySavedHeader}>
            <PiggyBank size={14} color={theme.colors.successDeep} strokeWidth={2} />
            <Text style={styles.moneySavedLabel}>This week you saved</Text>
          </View>
          {/* The Odometer is the single a11y node here — the "$" glyph is
              decorative, and nesting another `accessible` view around it would
              make TalkBack read the amount twice. */}
          <View style={styles.moneySavedRow}>
            <Text
              style={styles.moneySavedAmount}
              accessibilityElementsHidden
              importantForAccessibility="no"
            >
              $
            </Text>
            <Odometer
              value={weeklyWalks * 8}
              places={placesFor(weeklyWalks * 8)}
              style={styles.moneySavedAmount}
              accessibilityLabel={`Saved ${weeklyWalks * 8} dollars this week`}
            />
          </View>
          <Text style={styles.moneySavedSub}>vs. {weeklyWalks} Uber trips at ~$8 each</Text>
        </FadeInView>
      )}

      {/* Today's walks */}
      <FadeInView delay={350}>
        <Text style={styles.sectionTitle} accessibilityRole="header">Today's walks</Text>
      </FadeInView>
      {todayEntries.length === 0 ? (
        <FadeInView delay={400} style={styles.emptyCard}>
          <EmptyState
            icon={Footprints}
            title="No walks yet today"
            subtitle="Use the Walk button on the Home screen to start tracking."
          />
        </FadeInView>
      ) : (
        <View style={styles.walksCard}>
          {/* Shared list cadence with a cap, replacing the uncapped
              delay={i * 60} ladder — a long day of walks no longer makes the
              last row wait out the whole list. */}
          <Stagger step={STAGGER.listStep} cap={STAGGER.listCap}>
            {todayEntries.map((e, i) => (
              <View key={e.id} style={[styles.entryRow, i > 0 && styles.entryRowBorder]}>
                <Text style={styles.entryRoute}>{e.from} → {e.to}</Text>
                <Text style={styles.entryMeta}>
                  {e.walkingModeId} · {formatDistance(e.distanceM)} · {Math.floor(e.durationSeconds / 60)} min · {e.caloriesBurned.toFixed(1)} kcal · {e.stepCount} steps
                </Text>
              </View>
            ))}
          </Stagger>
        </View>
      )}

      {/* Pattern insights */}
      {patternInsights !== null && (
        <FadeInView delay={420}>
          <PatternInsightCards
            insights={patternInsights}
            dismissedKeys={dismissedInsightKeys}
            onDismiss={handleDismissInsight}
          />
        </FadeInView>
      )}

      {/* AI disclosure card */}
      {showAiDisclosure && (
        <FadeInView delay={0} style={styles.disclosureCard}>
          <View style={styles.disclosureHeader}>
            <ShieldCheck size={16} color={theme.colors.brandInk} strokeWidth={2} />
            <Text style={styles.disclosureTitle}>Before we continue</Text>
          </View>
          <Text style={styles.disclosureBody}>
            To generate your report, your step count, distance, and walk history for today will be sent to an AI service. No personal identifiers are included.
          </Text>
          <View style={styles.disclosureRow}>
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="secondary" onPress={() => setShowAiDisclosure(false)} />
            </View>
            <View style={{ flex: 2 }}>
              <Button
                label="Allow & Generate"
                onPress={async () => {
                  await AsyncStorage.setItem(AI_DISCLOSURE_KEY, '1');
                  doGetReport();
                }}
              />
            </View>
          </View>
        </FadeInView>
      )}

      {/* AI Report button */}
      <FadeInView delay={490} style={styles.reportBtnWrap}>
        <Button
          label="Get AI Report"
          icon={Sparkles}
          onPress={onGetReport}
          loading={reportLoading}
          disabled={reportLoading}
        />
      </FadeInView>

      {reportError && (
        <FadeInView delay={0} style={styles.reportError}>
          <AlertCircle size={16} color={theme.colors.errorDeep} />
          <Text style={styles.reportErrorText}>{reportError}</Text>
        </FadeInView>
      )}

      {reportText && (
        <FadeInView delay={0} style={styles.reportCardWrap}>
          <LinearGradient
            colors={[theme.gradients.glowCard[0], theme.gradients.glowCard[1]]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.reportCard}
          >
            <View style={styles.reportHeader}>
              <Sparkles size={14} color={theme.colors.brandInk} strokeWidth={2} />
              <Text style={styles.reportEyebrow}>Today's report</Text>
            </View>
            <Text style={styles.reportQuoteMark} accessible={false}>“</Text>
            <View style={styles.reportQuoteRow}>
              <View style={styles.reportQuoteRule} />
              <Text style={styles.reportBody}>{reportText}</Text>
            </View>
          </LinearGradient>
        </FadeInView>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.surfaceAlt },
  container: { padding: theme.layout.gutter, paddingBottom: 40 },

  // First-load skeletons, laid out like the real screen
  loadingWrap: {
    flex: 1,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.layout.gutter,
    gap: theme.layout.gutter,
  },
  loadingRow: { flexDirection: "row", gap: theme.layout.cardGap },

  // Auto-walk banner
  banner: {
    flexDirection: "row",
    gap: theme.spacing.md,
    backgroundColor: theme.colors.orangeSoft,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.orange,
    borderRadius: theme.radius.xl,
    padding: 14,
    marginBottom: theme.layout.cardGap,
    ...theme.elevation[1],
  },
  bannerIconHalo: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  bannerTitle: { ...theme.text.subhead, color: theme.colors.navy },
  bannerBody: { ...theme.text.caption, fontVariant: ["tabular-nums" as const], color: theme.colors.textSecondary, marginTop: 1 },
  bannerActions: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, marginTop: theme.spacing.sm },

  // Today hero
  todayCard: {
    borderRadius: theme.radius.xxl,
    padding: theme.spacing.lg,
    marginBottom: theme.layout.gutter,
    overflow: "hidden",
    ...theme.shadows.glowNavy,
  },
  todayEyebrow: { ...theme.text.eyebrow, color: theme.colors.textOnNavyMuted, marginBottom: theme.spacing.sm },
  todayHeroValue: { ...theme.text.display, fontSize: 48, lineHeight: 54, color: theme.colors.surface },
  todayHeroLabel: { ...theme.text.eyebrow, color: theme.colors.textOnNavyMuted, marginTop: 2, marginBottom: theme.spacing.md },
  // Fixed height so the hero card keeps its size on the frame before the spark
  // has measured itself.
  trendWrap: { height: TREND_H, marginBottom: theme.spacing.md },
  todayStats: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.14)",
    paddingTop: theme.spacing.md,
  },
  statCell: { alignItems: "center", flex: 1 },
  statDivider: { width: 1, height: 26, backgroundColor: "rgba(255,255,255,0.14)" },
  statValue: { ...theme.text.numeric, fontSize: 20, lineHeight: 26, color: theme.colors.surface },
  statLabel: { ...theme.text.caption, fontSize: 11, lineHeight: 14, color: theme.colors.textOnNavyMuted, marginTop: 2 },

  // Streak + weekly goal
  // The flex ratio now lives on the entrance wrappers, so the two cards can
  // stagger in without the row losing its 1.25 : 1 proportions.
  streakRow: { flexDirection: "row", gap: theme.layout.cardGap, marginBottom: theme.layout.gutter },
  streakSlotWide: { flex: 1.25 },
  streakSlot: { flex: 1 },
  weeklyCard: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: 14,
    justifyContent: "center",
    ...theme.elevation[2],
  },
  weeklyHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: theme.spacing.xs },
  weeklyLabel: { ...theme.text.eyebrow, color: theme.colors.textMuted },
  weeklyEditBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minHeight: theme.layout.tapMin,
    paddingLeft: theme.spacing.sm,
  },
  weeklyFraction: { ...theme.text.numeric, fontSize: 11, lineHeight: 14, color: theme.colors.brandInk },
  weeklyRingWrap: { alignItems: "center", paddingBottom: theme.spacing.xs },
  weeklyPctBig: { ...theme.text.numeric, fontSize: 24, lineHeight: 30, color: theme.colors.navy },
  weeklyPctSub: { ...theme.text.caption, fontSize: 11, lineHeight: 14, color: theme.colors.textMuted, marginTop: 1 },
  // Over-goal is stated in words and an icon, never by the ring's color alone.
  weeklyMetRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 1 },
  weeklyMetText: { ...theme.text.caption, fontSize: 11, lineHeight: 14, color: theme.colors.successDeep, fontFamily: "DMSans_700Bold" },
  streakCard: {
    flex: 1,
    borderRadius: theme.radius.xl,
    padding: 14,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadows.glowNavy,
  },
  streakFlame: { marginBottom: 2 },
  streakCount: { ...theme.text.display, fontSize: 40, lineHeight: 46, color: theme.colors.gold, textAlign: "center" },
  streakLabel: { ...theme.text.badge, color: theme.colors.textOnNavy, marginTop: 2 },
  streakHint: { ...theme.text.caption, fontSize: 11, lineHeight: 15, color: theme.colors.textOnNavyMuted, marginTop: 4, textAlign: "center" },

  // Goal suggestion
  goalSuggestion: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.successSoft,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    marginBottom: theme.layout.cardGap,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.successDeep,
  },
  goalSuggestionText: { flex: 1, ...theme.text.caption, color: theme.colors.successDeep },

  // 7-day chart
  chartCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: theme.layout.gutter,
    marginBottom: theme.spacing.lg,
    ...theme.elevation[2],
  },
  chartHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: theme.spacing.md },
  chartTitle: { ...theme.text.eyebrow, color: theme.colors.textMuted },
  // BarRow lays its bars out at a fixed width from the left; centering the
  // block keeps the plot optically centred in the card at any screen size.
  chartPlot: { alignItems: "center" },

  // Section heading
  sectionTitle: { ...theme.text.title2, color: theme.colors.navy, marginBottom: 10 },

  // Walk list
  emptyCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    marginBottom: theme.layout.gutter,
    ...theme.elevation[1],
  },
  walksCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    marginBottom: theme.layout.gutter,
    overflow: "hidden",
    ...theme.elevation[2],
  },
  entryRow: { paddingVertical: theme.spacing.md, paddingHorizontal: theme.layout.gutter },
  entryRowBorder: { borderTopWidth: 1, borderTopColor: theme.colors.borderSoft },
  entryRoute: { ...theme.text.subhead, color: theme.colors.text },
  entryMeta: { ...theme.text.caption, fontSize: 12, color: theme.colors.textSecondary, marginTop: 3, fontVariant: ["tabular-nums" as const] },

  // Commute summary
  commuteSummaryCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: theme.layout.gutter,
    marginBottom: theme.layout.gutter,
    ...theme.elevation[2],
  },
  commuteSummaryTitle: { ...theme.text.eyebrow, color: theme.colors.textMuted, marginBottom: theme.spacing.md },
  commuteSummaryRow: { flexDirection: "row", justifyContent: "space-around", marginBottom: theme.spacing.sm },
  commuteStat: { alignItems: "center" },
  commuteStatValue: { ...theme.text.numeric, fontSize: 22, lineHeight: 28, color: theme.colors.navy },
  commuteStatLabel: { ...theme.text.caption, fontSize: 11, lineHeight: 14, color: theme.colors.textMuted, marginTop: 2 },
  commuteTopDest: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderSoft,
    paddingTop: theme.spacing.sm,
    marginTop: 4,
  },
  commuteTopDestText: { ...theme.text.caption, fontSize: 12, color: theme.colors.textSecondary },

  // Money saved
  moneySavedCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: 18,
    marginBottom: theme.spacing.lg,
    alignItems: "center",
    ...theme.elevation[2],
  },
  moneySavedHeader: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 4 },
  moneySavedLabel: { ...theme.text.eyebrow, color: theme.colors.successDeep },
  moneySavedRow: { flexDirection: "row", alignItems: "center" },
  moneySavedAmount: { ...theme.text.display, fontSize: 44, lineHeight: 50, color: theme.colors.successDeep },
  moneySavedSub: { ...theme.text.caption, fontSize: 12, color: theme.colors.textMuted, marginTop: 4 },

  // AI report
  reportBtnWrap: { marginTop: theme.layout.gutter, marginBottom: theme.layout.cardGap },
  reportError: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.errorSoft,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    marginBottom: theme.layout.cardGap,
  },
  reportErrorText: { flex: 1, ...theme.text.caption, fontSize: 14, lineHeight: 20, color: theme.colors.errorDeep },
  reportCardWrap: { borderRadius: theme.radius.xl, ...theme.elevation[2] },
  reportCard: {
    borderRadius: theme.radius.xl,
    padding: theme.spacing.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
  },
  reportHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: theme.spacing.sm },
  reportEyebrow: { ...theme.text.eyebrow, color: theme.colors.brandInk },
  reportQuoteMark: { fontFamily: "DMSerifDisplay_400Regular", fontSize: 44, lineHeight: 46, color: theme.colors.brandInk, marginBottom: -16 },
  reportQuoteRow: { flexDirection: "row", gap: theme.spacing.md },
  reportQuoteRule: { width: 3, borderRadius: 2, backgroundColor: theme.colors.orange },
  reportBody: { flex: 1, fontFamily: "DMSerifDisplay_400Regular", fontSize: 17, lineHeight: 26, color: theme.colors.text },

  // AI disclosure
  disclosureCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: theme.layout.gutter,
    marginTop: theme.layout.gutter,
    marginBottom: theme.spacing.sm,
    ...theme.elevation[2],
  },
  disclosureHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: theme.spacing.sm },
  disclosureTitle: { ...theme.text.heading, fontSize: 15, color: theme.colors.navy },
  disclosureBody: { ...theme.text.caption, lineHeight: 20, color: theme.colors.textSecondary, marginBottom: theme.spacing.md },
  disclosureRow: { flexDirection: "row", gap: 10 },
});
