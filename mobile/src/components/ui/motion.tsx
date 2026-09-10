/**
 * Motion primitives — the shared animation vocabulary for UIUC Bustle.
 *
 * - useReducedMotion:  live system reduce-motion flag (looping primitives obey it)
 * - PressableScale:    springy scale-down on press (+ optional haptic tick)
 * - FadeInView:        fade + slide entrance, staggerable via `delay`
 * - PulseView:         looping soft pulse for "live" indicators
 * - FloatingView:      slow vertical drift for decorative elements
 * - Skeleton:          shimmer loading placeholder
 * - ProgressRing:      animated SVG progress circle
 * - AnimatedBar:       grow-in bar for charts
 * - TickingCountdown:  live mm / m:ss countdown on a shared 1s ticker (tabular-nums)
 * - AnimatedNumber:    rolling digit swaps for in-place numeric updates
 * - RouteProgress:     SVG polyline that draws itself, with optional traveling dot
 * - CelebrationBurst:  one-shot radial particle burst for arrivals
 *
 * v2 additions (motion-system rebuild):
 * - useGlide:            spring a SharedValue at a target that changes over time
 * - useCountdownSeconds: seconds-remaining SharedValue on the shared 1s ticker
 * - useScrollProgress:   scroll handler + clamped 0..1 progress
 * - Stagger:             the ONE entrance vocabulary (replaces delay={i * 60})
 * - Press:               scale / lift / tint press surface, 44pt + a11y enforced
 * - Beacon:              slow expanding halo ring (schedule, not a loop)
 * - Odometer:            rolling digit columns, zero re-renders per tick
 * - Reveal:              non-SVG clip reveal driven by a SharedValue
 */
import {
  HAPTIC,
  SPRING,
  STAGGER,
  TIMING,
  type HapticKey,
} from "@/src/constants/motion";
import { theme } from "@/src/constants/theme";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated, {
  cancelAnimation,
  css,
  Easing,
  FadeInDown,
  FadeOutUp,
  interpolateColor,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
  type WithSpringConfig,
  type WithTimingConfig,
} from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Polyline, Stop } from "react-native-svg";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPolyline = Animated.createAnimatedComponent(Polyline);

// ── useReducedMotion ──────────────────────────────────────────────────────

// One AccessibilityInfo subscription for the whole app. A loading screen can
// mount a dozen Skeletons; each of them adding its own native listener + state
// hook is pure overhead, and they would all answer the same question.
let reduceMotionValue = false;
let reduceMotionSub: { remove: () => void } | null = null;
const reduceMotionListeners = new Set<() => void>();

function emitReduceMotion(next: boolean) {
  if (next === reduceMotionValue) return;
  reduceMotionValue = next;
  reduceMotionListeners.forEach((l) => l());
}

function subscribeToReduceMotion(listener: () => void): () => void {
  reduceMotionListeners.add(listener);
  if (reduceMotionListeners.size === 1) {
    AccessibilityInfo.isReduceMotionEnabled().then(emitReduceMotion).catch(() => {});
    reduceMotionSub = AccessibilityInfo.addEventListener("reduceMotionChanged", emitReduceMotion);
  }
  return () => {
    reduceMotionListeners.delete(listener);
    if (reduceMotionListeners.size === 0) {
      reduceMotionSub?.remove();
      reduceMotionSub = null;
    }
  };
}

function getReduceMotion(): boolean {
  return reduceMotionValue;
}

/**
 * Live "Reduce Motion" system setting. Looping primitives in this file obey
 * it internally; use it yourself before starting any decorative loop.
 *
 * Deliberately NOT Reanimated's `useReducedMotion()` — that one snapshots the
 * setting at module import and never updates, so a user who flips the switch
 * in Settings keeps the old behavior until the app is killed.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReduceMotion, getReduceMotion, getReduceMotion);
}

// ── Haptics ───────────────────────────────────────────────────────────────

/**
 * Fire the haptic named by a `HAPTIC` intent key. Silently no-ops if the
 * device has no haptic engine — never let feedback throw into a press handler.
 */
export function fireHaptic(key: HapticKey): void {
  const kind = HAPTIC[key];
  switch (kind) {
    case "selection":
      Haptics.selectionAsync().catch(() => {});
      return;
    case "light":
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      return;
    case "medium":
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      return;
    case "success":
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return;
    case "warning":
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
  }
}

// ── Press / PressableScale ────────────────────────────────────────────────

/** How a press surface reacts to touch. */
export type PressVariant = "scale" | "lift" | "tint";

interface PressBaseProps extends Omit<PressableProps, "style"> {
  variant?: PressVariant;
  /** Haptic intent on press-in, or `false` for silence. */
  haptic?: HapticKey | false;
  /** `scale` variant: pressed scale. Default 0.96. */
  scaleTo?: number;
  /** `lift` variant: px raised on press. Default 2. */
  liftBy?: number;
  /**
   * `tint` variant: resting background. Default is `tintTo` at zero alpha —
   * pair a custom `tintTo` with its own zero-alpha `tintFrom`, or the
   * crossfade passes through transparent BLACK on its way there.
   */
  tintFrom?: string;
  /** `tint` variant: pressed background. Default a soft neutral wash. */
  tintTo?: string;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/** Shared implementation. `Press` enforces the a11y floor; `PressableScale` does not. */
function PressBase({
  variant = "scale",
  haptic = "tap",
  scaleTo = 0.96,
  liftBy = 2,
  tintFrom = "rgba(234,237,242,0)", // theme.colors.borderSoft, alpha 0
  tintTo = theme.colors.borderSoft,
  enforceTapTarget,
  style,
  children,
  onPressIn,
  onPressOut,
  ...rest
}: PressBaseProps & { enforceTapTarget: boolean }) {
  const t = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => {
    const p = t.value;
    if (variant === "tint") {
      return { backgroundColor: interpolateColor(p, [0, 1], [tintFrom, tintTo]) };
    }
    if (variant === "lift") {
      // Shadow grows with the lift so the card reads as leaving the surface,
      // not sliding across it.
      return {
        transform: [{ translateY: -liftBy * p }],
        shadowOpacity: 0.06 + 0.1 * p,
        shadowRadius: 4 + 8 * p,
        elevation: 1 + 4 * p,
      };
    }
    return { transform: [{ scale: 1 - (1 - scaleTo) * p }] };
  }, [variant, scaleTo, liftBy, tintFrom, tintTo]);

  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        t.value = withSpring(1, SPRING.press);
        if (haptic !== false) fireHaptic(haptic);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        t.value = withSpring(0, SPRING.settle);
        onPressOut?.(e);
      }}
    >
      <Animated.View
        style={[
          variant === "lift" && { shadowColor: theme.colors.navy, shadowOffset: { width: 0, height: 2 } },
          // Before `style`: centering is only a sensible DEFAULT for the extra
          // height the 44pt floor adds. A row that wants `space-between` (or a
          // `flex-end` price tag) must still be able to say so.
          enforceTapTarget && { justifyContent: "center" as const },
          style,
          // After `style` on purpose: the 44pt floor is not negotiable per call site.
          enforceTapTarget && { minHeight: theme.layout.tapMin },
          animatedStyle,
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

export interface PressProps extends PressBaseProps {
  /**
   * Required. A press surface with no role is invisible to assistive tech, and
   * this is the one place we can force the answer at compile time.
   */
  accessibilityRole: NonNullable<PressableProps["accessibilityRole"]>;
}

/**
 * The press surface. Three reactions, one contract:
 *   scale — the default; content shrinks under the finger.
 *   lift  — content rises 2px and its shadow deepens (cards, tiles).
 *   tint  — background crossfades (rows, list items, anything full-bleed).
 *
 * Enforces a 44pt minimum tap height and a declared `accessibilityRole`.
 */
export function Press(props: PressProps) {
  return <PressBase {...props} enforceTapTarget />;
}

interface PressableScaleProps extends PressableProps {
  /** How far to scale down while pressed. Default 0.96. */
  scaleTo?: number;
  /** Fire a light haptic tick on press-in. Default true. */
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * Pressable that springs down on touch — makes every tap feel alive.
 *
 * Now `<Press variant="scale">` underneath, minus the 44pt enforcement so the
 * ~20 existing call sites keep their exact layout. New code should use `Press`.
 */
export function PressableScale({ scaleTo = 0.96, haptic = true, style, children, ...rest }: PressableScaleProps) {
  return (
    <PressBase
      {...rest}
      enforceTapTarget={false}
      variant="scale"
      scaleTo={scaleTo}
      haptic={haptic ? "tap" : false}
      accessibilityRole={rest.accessibilityRole ?? "button"}
      style={style}
    >
      {children}
    </PressBase>
  );
}

// ── FadeInView ────────────────────────────────────────────────────────────

interface FadeInViewProps {
  /** Stagger offset in ms. */
  delay?: number;
  /** Slide-up distance in px. Default 14. */
  dy?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/** Fade + slide entrance. Stagger lists by passing `delay={index * 60}`. */
export function FadeInView({ delay = 0, dy = 14, duration = theme.motion.slow, style, children }: FadeInViewProps) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withDelay(delay, withTiming(1, { duration, easing: Easing.out(Easing.cubic) }));
  }, [progress, delay, duration]);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * dy }],
  }));
  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}

// ── PulseView ─────────────────────────────────────────────────────────────

interface PulseViewProps {
  /** Pulse opacity floor. Default 0.45. */
  minOpacity?: number;
  /** Pulse scale ceiling. Default 1 (opacity-only). */
  maxScale?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/** Looping soft pulse — for Live badges, status dots, anything "breathing". */
export function PulseView({ minOpacity = 0.45, maxScale = 1, duration = 900, style, children }: PulseViewProps) {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(t);
      t.value = 0;
      return;
    }
    t.value = withRepeat(
      withSequence(
        withTiming(1, { duration, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration, easing: Easing.inOut(Easing.quad) })
      ),
      -1
    );
    return () => cancelAnimation(t);
  }, [t, duration, reduceMotion]);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - t.value * (1 - minOpacity),
    transform: [{ scale: 1 + t.value * (maxScale - 1) }],
  }));
  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}

// ── FloatingView ──────────────────────────────────────────────────────────

interface FloatingViewProps {
  /** Drift distance in px. Default 8. */
  distance?: number;
  duration?: number;
  delay?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/** Slow vertical drift — decorative blobs, icons, empty-state art. */
export function FloatingView({ distance = 8, duration = 2600, delay = 0, style, children }: FloatingViewProps) {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(t);
      t.value = 0;
      return;
    }
    t.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration, easing: Easing.inOut(Easing.sin) })
        ),
        -1
      )
    );
    return () => cancelAnimation(t);
  }, [t, duration, delay, reduceMotion]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -t.value * distance }],
  }));
  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}

// ── Skeleton ──────────────────────────────────────────────────────────────

interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

// The sheen sweeps in PERCENTAGES of its own box, so nothing has to be
// measured: no onLayout, no state, no shared value, no mapper. The keyframes
// and the style are created once at module scope and shared by every Skeleton
// on screen — a 12-skeleton loading state now costs zero animation drivers.
const skeletonSweep = css.keyframes({
  from: { transform: [{ translateX: "-100%" }] },
  to: { transform: [{ translateX: "100%" }] },
});

const skeletonStyles = css.create({
  sheen: {
    ...StyleSheet.absoluteFillObject,
    animationName: skeletonSweep,
    animationDuration: "1100ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  sheenStatic: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.5,
  },
});

/**
 * Shimmering loading placeholder — use instead of spinners for content.
 *
 * Pass fixed `width`/`height` (a percentage width is fine): the shimmer is
 * measurement-free by design, so a Skeleton with no size collapses.
 */
export function Skeleton({ width = "100%", height = 16, radius = theme.radius.md, style }: SkeletonProps) {
  const reduceMotion = useReducedMotion();
  return (
    <View
      style={[
        { width, height, borderRadius: radius, backgroundColor: theme.colors.borderSoft, overflow: "hidden" },
        style,
      ]}
    >
      <Animated.View style={reduceMotion ? skeletonStyles.sheenStatic : skeletonStyles.sheen}>
        <LinearGradient
          colors={["transparent", "rgba(255,255,255,0.75)", "transparent"]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

// ── ProgressRing ──────────────────────────────────────────────────────────

interface ProgressRingProps {
  /** 0..1 */
  progress: number;
  size?: number;
  strokeWidth?: number;
  /** Two-stop gradient for the progress stroke. */
  colors?: readonly [string, string];
  trackColor?: string;
  children?: React.ReactNode;
}

/** Animated circular progress with gradient stroke. Center children overlay. */
export function ProgressRing({
  progress,
  size = 120,
  strokeWidth = 10,
  colors = [theme.colors.orangeBright, theme.colors.orange],
  trackColor = theme.colors.borderSoft,
  children,
}: ProgressRingProps) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(150, withTiming(Math.min(Math.max(progress, 0), 1), { duration: 900, easing: Easing.out(Easing.cubic) }));
  }, [p, progress]);
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - p.value),
  }));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size}>
        <Defs>
          <SvgLinearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor={colors[0]} />
            <Stop offset="100%" stopColor={colors[1]} />
          </SvgLinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#ringGradient)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          animatedProps={animatedProps}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>{children}</View>
    </View>
  );
}

// ── AnimatedBar ───────────────────────────────────────────────────────────

interface AnimatedBarProps {
  /** Final height in px. */
  height: number;
  delay?: number;
  width?: number;
  color?: string;
  /** Optional gradient overrides `color`. */
  gradient?: readonly [string, string];
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Chart bar that grows in from the baseline. Stagger with `delay`.
 *
 * Grows with `scaleY` + `transformOrigin: 'bottom'`, never with `height`:
 * animating height re-runs layout for the bar (and its row) on every frame,
 * which is the single most expensive thing this file used to do. The layout
 * box is the FINAL height from the first frame; only the transform moves, so
 * a 7-bar week chart costs 7 transform writes and zero layout passes.
 */
export function AnimatedBar({ height, delay = 0, width = 18, color = theme.colors.navy, gradient, radius = 6, style }: AnimatedBarProps) {
  const target = Math.max(height, 0);
  const t = useSharedValue(0);
  const previous = useRef(0);
  useEffect(() => {
    cancelAnimation(t);
    // Re-render already moved the layout box to `target`; start the transform
    // wherever the bar visually was so a data change reads as a grow/shrink
    // rather than a jump.
    const from = previous.current > 0 && target > 0 ? previous.current / target : 0;
    previous.current = target;
    t.value = from;
    t.value = withDelay(delay, withSpring(1, SPRING.settle));
    return () => cancelAnimation(t);
  }, [t, target, delay]);
  const animatedStyle = useAnimatedStyle(() => ({
    // Exact 0 collapses the layer and can drop the gradient child on Android.
    transform: [{ scaleY: Math.max(t.value, 0.0001) }],
  }));
  return (
    <Animated.View
      style={[
        { width, height: target, borderRadius: radius, overflow: "hidden", transformOrigin: "bottom" },
        !gradient && { backgroundColor: color },
        animatedStyle,
        style,
      ]}
    >
      {gradient && (
        <LinearGradient colors={[gradient[0], gradient[1]]} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
      )}
    </Animated.View>
  );
}

// ── TickingCountdown ──────────────────────────────────────────────────────

// One shared 1s heartbeat for every countdown on screen — a departure board
// ticks in unison, and N countdowns cost one interval, not N.
type TickListener = () => void;
const tickListeners = new Set<TickListener>();
let tickHandle: ReturnType<typeof setInterval> | null = null;

function subscribeToTick(listener: TickListener): () => void {
  tickListeners.add(listener);
  if (tickHandle == null) {
    tickHandle = setInterval(() => {
      tickListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickHandle != null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  };
}

/** Format a remaining span (ms) as departure-board text. */
export function formatCountdown(remainingMs: number, nowLabel = "Now"): string {
  if (remainingMs <= 500) return nowLabel;
  const totalSeconds = Math.round(remainingMs / 1000);
  if (totalSeconds >= 90) return `${Math.round(totalSeconds / 60)} min`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface TickingCountdownProps {
  /** Target time as epoch ms (or ISO-parsed). Live-ticks on the shared 1s heartbeat. */
  targetMs?: number | null;
  /** Static minutes fallback when no target time is known. */
  minutes?: number | null;
  /** Label when the countdown reaches zero. Default "Now". */
  nowLabel?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

/**
 * Live countdown text. Below 90s it switches from "7 min" to "1:23" and ticks
 * every second on a single shared interval; cleans up on unmount. Digits are
 * tabular so the row never jitters.
 */
export function TickingCountdown({ targetMs, minutes, nowLabel = "Now", style, numberOfLines = 1 }: TickingCountdownProps) {
  const [, forceTick] = useState(0);
  const live = targetMs != null && Number.isFinite(targetMs);
  useEffect(() => {
    if (!live) return;
    return subscribeToTick(() => forceTick((n) => (n + 1) % 1_000_000));
  }, [live]);

  let text: string;
  if (live) {
    text = formatCountdown((targetMs as number) - Date.now(), nowLabel);
  } else if (minutes != null && Number.isFinite(minutes)) {
    text = minutes <= 0 ? nowLabel : `${Math.round(minutes)} min`;
  } else {
    text = "—";
  }

  return (
    <Text style={[{ fontVariant: ["tabular-nums"] }, style]} numberOfLines={numberOfLines}>
      {text}
    </Text>
  );
}

// ── AnimatedNumber ────────────────────────────────────────────────────────

interface AnimatedNumberProps {
  /** The value to display; each change rolls the old value out and the new one in. */
  value: number | string;
  style?: StyleProp<TextStyle>;
  duration?: number;
  accessibilityLabel?: string;
}

/**
 * Numeric text that rolls on change (old value slides up/out, new slides in).
 * Tabular-nums built in; static under reduced motion.
 */
export function AnimatedNumber({ value, style, duration = theme.motion.fast, accessibilityLabel }: AnimatedNumberProps) {
  const reduceMotion = useReducedMotion();
  const key = String(value);
  return (
    <View accessible accessibilityLabel={accessibilityLabel ?? key}>
      <Animated.Text
        key={key}
        entering={reduceMotion ? undefined : FadeInDown.duration(duration).easing(Easing.out(Easing.cubic))}
        exiting={reduceMotion ? undefined : FadeOutUp.duration(duration).easing(Easing.in(Easing.cubic))}
        style={[{ fontVariant: ["tabular-nums"] }, style]}
      >
        {key}
      </Animated.Text>
    </View>
  );
}

// ── RouteProgress ─────────────────────────────────────────────────────────

export interface RoutePoint {
  x: number;
  y: number;
}

interface RouteProgressProps {
  /** Polyline vertices in local SVG coordinates. */
  points: RoutePoint[];
  color?: string;
  strokeWidth?: number;
  /** Draw-on duration in ms. */
  duration?: number;
  /** Restart the draw-on (and dot travel) forever. */
  loop?: boolean;
  /** Render a dot that travels the path as it draws. */
  showDot?: boolean;
  dotColor?: string;
  dotRadius?: number;
  /** Faint full-length track behind the drawing line. */
  trackColor?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * An SVG polyline that draws itself (strokeDashoffset), with an optional dot
 * traveling the path — a bus gliding along its route. Under reduced motion the
 * line renders fully drawn with the dot resting at the end.
 *
 * The track, the drawing line, and the traveling dot are three absolutely
 * stacked `<Svg>`s of identical geometry (the same layering Charts.tsx's
 * gauge uses): on Fabric, ANY animated prop write invalidates the WHOLE
 * enclosing `<Svg>`, so the line and the dot sharing one document would
 * re-render each other — and the static track — on every frame, forever on
 * a looping instance.
 */
export function RouteProgress({
  points,
  color = theme.colors.orange,
  strokeWidth = 3,
  duration = 1400,
  loop = false,
  showDot = true,
  dotColor = theme.colors.orange,
  dotRadius = 5,
  trackColor,
  style,
}: RouteProgressProps) {
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(0);

  const geometry = useMemo(() => {
    const xs = points.map((pt) => pt.x);
    const ys = points.map((pt) => pt.y);
    const pad = Math.max(strokeWidth, dotRadius) + 2;
    const minX = Math.min(...xs, 0);
    const minY = Math.min(...ys, 0);
    const width = Math.max(...xs, 1) - Math.min(minX, 0) + pad * 2;
    const height = Math.max(...ys, 1) - Math.min(minY, 0) + pad * 2;
    const shifted = points.map((pt) => ({ x: pt.x - minX + pad, y: pt.y - minY + pad }));
    const svgPoints = shifted.map((pt) => `${pt.x},${pt.y}`).join(" ");
    // Cumulative segment lengths for dot interpolation (plain arrays — worklet-safe).
    const cumulative: number[] = [0];
    let total = 0;
    for (let i = 1; i < shifted.length; i++) {
      total += Math.hypot(shifted[i].x - shifted[i - 1].x, shifted[i].y - shifted[i - 1].y);
      cumulative.push(total);
    }
    return {
      width,
      height,
      svgPoints,
      xsShifted: shifted.map((pt) => pt.x),
      ysShifted: shifted.map((pt) => pt.y),
      cumulative,
      total: Math.max(total, 1e-6),
    };
  }, [points, strokeWidth, dotRadius]);

  useEffect(() => {
    cancelAnimation(p);
    if (reduceMotion) {
      p.value = 1;
      return;
    }
    p.value = 0;
    const draw = withTiming(1, { duration, easing: Easing.inOut(Easing.cubic) });
    p.value = loop ? withRepeat(withSequence(draw, withDelay(400, withTiming(0, { duration: 0 }))), -1) : draw;
    return () => cancelAnimation(p);
  }, [p, duration, loop, reduceMotion, geometry.total]);

  const lineProps = useAnimatedProps(() => ({
    strokeDashoffset: geometry.total * (1 - p.value),
  }));

  const dotProps = useAnimatedProps(() => {
    const dist = geometry.total * p.value;
    const cum = geometry.cumulative;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dist) i++;
    const segLen = Math.max(cum[i] - cum[i - 1], 1e-6);
    const tt = Math.min(Math.max((dist - cum[i - 1]) / segLen, 0), 1);
    const cx = geometry.xsShifted[i - 1] + (geometry.xsShifted[i] - geometry.xsShifted[i - 1]) * tt;
    const cy = geometry.ysShifted[i - 1] + (geometry.ysShifted[i] - geometry.ysShifted[i - 1]) * tt;
    return { cx, cy, opacity: p.value > 0.01 ? 1 : 0 };
  });

  if (points.length < 2) return null;

  return (
    <View style={[{ width: geometry.width, height: geometry.height }, style]}>
      {trackColor && (
        <Svg
          width={geometry.width}
          height={geometry.height}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <Polyline
            points={geometry.svgPoints}
            stroke={trackColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      )}
      <Svg
        width={geometry.width}
        height={geometry.height}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      >
        <AnimatedPolyline
          points={geometry.svgPoints}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={`${geometry.total} ${geometry.total}`}
          animatedProps={lineProps}
        />
      </Svg>
      {showDot && (
        <Svg
          width={geometry.width}
          height={geometry.height}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <AnimatedCircle r={dotRadius} fill={dotColor} animatedProps={dotProps} />
        </Svg>
      )}
    </View>
  );
}

// ── CelebrationBurst ──────────────────────────────────────────────────────

const BURST_COLORS = [theme.colors.orange, theme.colors.orangeBright, theme.colors.navy, theme.colors.sky, theme.colors.gold];

interface BurstParticleConfig {
  angle: number;
  distance: number;
  size: number;
  color: string;
  spin: number;
}

function BurstParticle({ progress, config }: { progress: SharedValue<number>; config: BurstParticleConfig }) {
  const animatedStyle = useAnimatedStyle(() => {
    const t = progress.value;
    const eased = 1 - (1 - t) * (1 - t); // ease-out
    return {
      opacity: t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3,
      transform: [
        { translateX: Math.cos(config.angle) * config.distance * eased },
        { translateY: Math.sin(config.angle) * config.distance * eased - 10 * t },
        { rotate: `${config.spin * t}deg` },
        { scale: 1 - 0.4 * t },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          width: config.size,
          height: config.size,
          borderRadius: config.size / 3,
          backgroundColor: config.color,
        },
        animatedStyle,
      ]}
    />
  );
}

interface CelebrationBurstProps {
  /** Particle count. Default 16. */
  count?: number;
  /** Max travel radius in px. Default 96. */
  radius?: number;
  duration?: number;
  /** Called after the burst finishes and unmounts its particles. */
  onDone?: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * One-shot radial burst of orange/navy/sky confetti for walk-arrival moments.
 * Fires on mount, cleans itself up when done, and no-ops under reduced motion.
 * Position it absolutely over the celebrating element.
 */
export function CelebrationBurst({ count = 16, radius = 96, duration = 750, onDone, style }: CelebrationBurstProps) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const [alive, setAlive] = useState(true);

  const particles = useMemo<BurstParticleConfig[]>(
    () =>
      Array.from({ length: count }, (_, i) => {
        const jitter = (Math.sin(i * 12.9898) * 43758.5453) % 1; // deterministic per index
        return {
          angle: (i / count) * Math.PI * 2 + jitter * 0.5,
          distance: radius * (0.55 + Math.abs(jitter) * 0.45),
          size: 5 + Math.abs(jitter) * 5,
          color: BURST_COLORS[i % BURST_COLORS.length],
          spin: 120 + Math.abs(jitter) * 240,
        };
      }),
    [count, radius]
  );

  useEffect(() => {
    if (reduceMotion) {
      setAlive(false);
      onDone?.();
      return;
    }
    const finish = () => {
      setAlive(false);
      onDone?.();
    };
    progress.value = withTiming(1, { duration, easing: Easing.out(Easing.quad) }, (finished) => {
      if (finished) runOnJS(finish)();
    });
    return () => cancelAnimation(progress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!alive) return null;

  return (
    <View pointerEvents="none" style={[{ alignItems: "center", justifyContent: "center" }, style]}>
      {particles.map((config, i) => (
        <BurstParticle key={i} progress={progress} config={config} />
      ))}
    </View>
  );
}

// ── useGlide ──────────────────────────────────────────────────────────────

export interface GlideConfig {
  /** Spring to use. Default `SPRING.settle`. Ignored when `timing` is set. */
  spring?: WithSpringConfig;
  /** Use a timing curve instead of a spring — e.g. `{ duration: GLIDE.vehicle }`. */
  timing?: WithTimingConfig;
  /** Value on first frame. Default: `target` (mounts at rest, no entrance). */
  from?: number;
  /** Delay before each retarget, ms. Default 0. */
  delay?: number;
}

/**
 * A SharedValue that chases `target` whenever `target` changes.
 *
 * Replaces the useSharedValue + useEffect + withSpring triple that this
 * codebase repeats ~9 times. Physics springs retarget mid-flight with velocity
 * carried over, so a value updated by a 5s poll never restarts from a stop.
 *
 *   const x = useGlide(vehicle.x, { timing: { duration: GLIDE.vehicle } });
 *
 * Cancels in flight on unmount, so a screen popped mid-glide leaves no
 * animation running against a detached view.
 */
export function useGlide(target: number, cfg?: GlideConfig): SharedValue<number> {
  const v = useSharedValue(cfg?.from ?? target);
  // Config is read at retarget time, not captured per render: passing an
  // inline object literal must not restart the animation every render.
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(() => {
    const c = cfgRef.current;
    const next = c?.timing ? withTiming(target, c.timing) : withSpring(target, c?.spring ?? SPRING.settle);
    v.value = c?.delay ? withDelay(c.delay, next) : next;
  }, [target, v]);

  useEffect(() => () => cancelAnimation(v), [v]);

  return v;
}

// ── useCountdownSeconds ───────────────────────────────────────────────────

/**
 * Seconds remaining until `targetMs`, as a SharedValue, driven by the same 1s
 * heartbeat `TickingCountdown` uses — one interval for the whole app.
 *
 * Nothing here re-renders React: the tick writes straight into the shared
 * value, so a screen with a dozen live countdowns re-renders zero times per
 * second. Feed it to `Odometer`, `Reveal`, or any animated style. Returns 0
 * (and stops ticking) when `targetMs` is null.
 */
export function useCountdownSeconds(targetMs: number | null): SharedValue<number> {
  const live = targetMs != null && Number.isFinite(targetMs);
  const seconds = useSharedValue(live ? Math.max(0, Math.round((targetMs as number - Date.now()) / 1000)) : 0);

  useEffect(() => {
    if (!live) {
      seconds.value = 0;
      return;
    }
    const write = () => {
      seconds.value = Math.max(0, Math.round(((targetMs as number) - Date.now()) / 1000));
    };
    write();
    return subscribeToTick(write);
  }, [targetMs, live, seconds]);

  return seconds;
}

// ── useScrollProgress ─────────────────────────────────────────────────────

export interface ScrollProgress {
  /** Spread onto an `Animated.ScrollView` / `Animated.FlatList`. */
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  /** Raw vertical content offset, px. */
  y: SharedValue<number>;
  /** `y / range`, clamped to 0..1. */
  progress: SharedValue<number>;
}

/**
 * Scroll offset and a clamped 0..1 progress over the first `range` px —
 * the driver for collapsing headers, fading hero art, and sticky-bar reveals.
 * Runs entirely on the UI thread; the scroll never touches React.
 */
export function useScrollProgress(range: number): ScrollProgress {
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      y.value = e.contentOffset.y;
    },
  });
  const progress = useDerivedValue(() => {
    const span = range > 0 ? range : 1;
    return Math.min(Math.max(y.value / span, 0), 1);
  }, [range]);
  return { onScroll, y, progress };
}

// ── Stagger ───────────────────────────────────────────────────────────────

interface StaggerProps {
  children: React.ReactNode;
  /** Per-item delay, ms. Default `STAGGER.step`. */
  step?: number;
  /** Index at which the delay stops growing. Default `STAGGER.cap`. */
  cap?: number;
  /** Slide-up distance, px. Default 12. */
  dy?: number;
  /** Render children with no entrance at all. */
  disabled?: boolean;
  duration?: number;
  /** Container style — set `flexDirection`/`gap` here. */
  style?: StyleProp<ViewStyle>;
  /** Applied to each item's animated wrapper. */
  itemStyle?: StyleProp<ViewStyle>;
}

/**
 * The entrance vocabulary. Wraps each child in a FadeInDown whose delay is
 * `min(index, cap) * step`.
 *
 * The cap is the point: with a raw `index * step`, item 30 of a list waits a
 * second and a half and the screen reads as hung. Use this instead of
 * hand-written `delay={index * 60}` so every list in the app enters the same
 * way. No entrance under reduced motion — children just appear.
 */
export function Stagger({
  children,
  step = STAGGER.step,
  cap = STAGGER.cap,
  dy = 12,
  disabled = false,
  duration = TIMING.base.duration,
  style,
  itemStyle,
}: StaggerProps) {
  const reduceMotion = useReducedMotion();
  const off = disabled || reduceMotion;
  const items = React.Children.toArray(children);
  return (
    <View style={style}>
      {items.map((child, i) => (
        <Animated.View
          key={React.isValidElement(child) && child.key != null ? child.key : i}
          style={itemStyle}
          entering={
            off
              ? undefined
              : FadeInDown.delay(Math.min(i, cap) * step)
                  .duration(duration)
                  .withInitialValues({ opacity: 0, transform: [{ translateY: dy }] })
          }
        >
          {child}
        </Animated.View>
      ))}
    </View>
  );
}

// ── Beacon ────────────────────────────────────────────────────────────────

interface BeaconProps {
  /** Diameter of the resting dot's box, px. */
  size: number;
  color?: string;
  /** Time between halos, ms. Default 6000. */
  period?: number;
  /** Emit halos. Default true. */
  active?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

const BEACON_EXPAND_MS = 1400;

/**
 * One halo ring that expands and fades, then waits.
 *
 * Deliberately a SCHEDULE, not a loop: a ring pulsing continuously beside live
 * data is visual noise that the eye stops reading within seconds, and it keeps
 * the UI thread busy forever. On a 6s period the halo is an event again.
 * Cancels on unmount and never starts under reduced motion — a looping
 * primitive has no meaningful end state to snap to, so the honest answer is
 * not to run it.
 */
export function Beacon({ size, color = theme.colors.orange, period = 6000, active = true, style, children }: BeaconProps) {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);

  useEffect(() => {
    if (!active || reduceMotion) {
      cancelAnimation(t);
      t.value = 0;
      return;
    }
    const rest = Math.max(period - BEACON_EXPAND_MS, 0);
    t.value = withRepeat(
      withSequence(
        withTiming(1, { duration: BEACON_EXPAND_MS, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 0 }),
        withDelay(rest, withTiming(0, { duration: 0 }))
      ),
      -1,
      false
    );
    return () => {
      cancelAnimation(t);
      t.value = 0;
    };
  }, [t, active, period, reduceMotion]);

  const halo = useAnimatedStyle(() => ({
    // Zero at BOTH ends: t rests at 0 between pulses, so a ring that is opaque
    // at t = 0 would sit on screen for the whole 4.6s gap.
    opacity: Math.min(t.value * 8, 1) * (1 - t.value) * 0.6,
    transform: [{ scale: 0.5 + t.value * 1.4 }],
  }));

  return (
    <View pointerEvents="none" style={[{ width: size, height: size, alignItems: "center", justifyContent: "center" }, style]}>
      <Animated.View
        style={[
          { position: "absolute", width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color },
          halo,
        ]}
      />
      {children}
    </View>
  );
}

// ── Odometer ──────────────────────────────────────────────────────────────

// One cell per digit. Wraps (9 -> 0, 0 -> 9) SNAP rather than roll — see
// DigitColumn — so the strip needs no extra cell to roll onto.
const ODOMETER_CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

interface DigitColumnProps {
  v: SharedValue<number>;
  /** Power of ten this column shows: 0 = ones, 1 = tens, ... */
  place: number;
  /** Window height; equals the text lineHeight. */
  h: number;
  textStyle: StyleProp<TextStyle>;
  padWithZeros: boolean;
}

const DigitColumn = React.memo(function DigitColumn({ v, place, h, textStyle, padWithZeros }: DigitColumnProps) {
  // The column's y offset, retargeted per digit change. The previous digit is
  // tracked (useAnimatedReaction hands it over) so only an ADJACENT step rolls:
  // a wrap (9 -> 0, or 0 -> 9 on a countdown) or any jump SNAPS to its target.
  // Tweening a wrap would slide the strip through every intermediate digit —
  // 9 -> 0 read as a full backwards spin through 8, 7, 6...
  const y = useSharedValue(0);

  useAnimatedReaction(
    () => {
      const pow = Math.pow(10, place);
      return Math.floor(Math.max(v.value, 0) / pow) % 10;
    },
    (digit, previous) => {
      const target = -digit * h;
      if (previous === null || Math.abs(digit - previous) !== 1) {
        y.value = target;
      } else {
        y.value = withTiming(target, TIMING.base);
      }
    },
    [place, h]
  );

  const animatedStyle = useAnimatedStyle(() => {
    const pow = Math.pow(10, place);
    return {
      opacity: padWithZeros || place === 0 || Math.max(v.value, 0) >= pow ? 1 : 0,
      transform: [{ translateY: y.value }],
    };
  }, [place, padWithZeros]);

  return (
    <View style={{ height: h, overflow: "hidden" }}>
      <Animated.View style={animatedStyle}>
        {ODOMETER_CELLS.map((cell, i) => (
          <Text key={i} style={[textStyle, { height: h, lineHeight: h, textAlign: "center" }]}>
            {cell}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
});

interface OdometerProps {
  /**
   * A plain number, or a SharedValue for a truly render-free digit (pair it
   * with `useCountdownSeconds`).
   */
  value: number | SharedValue<number>;
  /** Digit columns, most significant first. `places={2}` shows 00..99. */
  places: number;
  style?: StyleProp<TextStyle>;
  /**
   * Required and STABLE — "minutes until the 22N" — never the live number.
   * A label that changes every second makes VoiceOver interrupt itself
   * forever and the screen becomes unusable.
   */
  accessibilityLabel: string;
  /** Window height. Defaults to the style's lineHeight, else fontSize * 1.2. */
  digitHeight?: number;
  /** Roll duration when `value` is a plain number. */
  duration?: number;
  /** Show leading zeros. Default true. */
  padWithZeros?: boolean;
}

/**
 * Rolling digit columns — a departure board, not a text swap.
 *
 * Each place is a fixed strip inside an `overflow: hidden` window, positioned
 * by a `useDerivedValue`-style worklet off ONE shared value, so a digit change
 * costs zero React renders and zero layout. Heights are explicit (lineHeight
 * === window height): nothing is measured, so there is no first-frame jump.
 */
export function Odometer({
  value,
  places,
  style,
  accessibilityLabel,
  digitHeight,
  duration = TIMING.base.duration,
  padWithZeros = true,
}: OdometerProps) {
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  const fontSize = typeof flat?.fontSize === "number" ? flat.fontSize : 16;
  const h = digitHeight ?? (typeof flat?.lineHeight === "number" ? flat.lineHeight : Math.round(fontSize * 1.2));

  const isShared = typeof value !== "number";
  const internal = useSharedValue(typeof value === "number" ? value : 0);
  const v = isShared ? (value as SharedValue<number>) : internal;

  // Stable identity, or the memo on DigitColumn never hits: a fresh array
  // literal per render invalidates every column on every parent render.
  const digitTextStyle = useMemo<StyleProp<TextStyle>>(() => [{ fontVariant: ["tabular-nums"] }, style], [style]);

  useEffect(() => {
    if (typeof value === "number") {
      internal.value = withTiming(value, { duration, easing: Easing.out(Easing.cubic) });
    }
  }, [value, duration, internal]);

  useEffect(() => () => cancelAnimation(internal), [internal]);

  const columns: number[] = [];
  for (let i = places - 1; i >= 0; i--) columns.push(i);

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={{ flexDirection: "row" }}
    >
      <View style={{ flexDirection: "row" }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {columns.map((place) => (
          <DigitColumn
            key={place}
            v={v}
            place={place}
            h={h}
            padWithZeros={padWithZeros}
            textStyle={digitTextStyle}
          />
        ))}
      </View>
    </View>
  );
}

// ── Reveal ────────────────────────────────────────────────────────────────

/** Edge the reveal grows toward. */
export type RevealDirection = "right" | "left" | "up" | "down";

interface RevealProps {
  /** 0..1 driver. Clamped internally. */
  progress: SharedValue<number>;
  /** Default "right" — grows from the left edge. */
  direction?: RevealDirection;
  /**
   * Full extent along the reveal axis, px. REQUIRED: the clip is a fixed-size
   * window whose content is translated, so the reveal costs one transform per
   * frame and never re-lays-out. Without a size the window would collapse to
   * zero (a parent cannot infer it from an absolutely-clipped child).
   */
  size: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Clips its children to `progress` — the non-SVG reveal behind progress bars,
 * chart wipes, and fill meters.
 *
 * Only the clip's own box animates; the content inside keeps its full size and
 * is simply cut off, so text never reflows and a gradient never restretches
 * mid-animation.
 */
export function Reveal({ progress, direction = "right", size, children, style }: RevealProps) {
  const horizontal = direction === "left" || direction === "right";
  const anchor: ViewStyle = {
    alignItems: direction === "left" ? "flex-end" : "flex-start",
    justifyContent: direction === "up" ? "flex-end" : "flex-start",
  };

  // Transform-only: the window is a fixed box and the content slides inside it.
  // Animating width/height here would re-lay-out the children every frame,
  // which is the single worst pattern available on this stack.
  const contentStyle = useAnimatedStyle(() => {
    const t = Math.min(Math.max(progress.value, 0), 1);
    const hidden = size * (1 - t);
    if (horizontal) {
      return { transform: [{ translateX: direction === "right" ? -hidden : hidden }] };
    }
    return { transform: [{ translateY: direction === "down" ? -hidden : hidden }] };
  }, [horizontal, direction, size]);

  const windowStyle: ViewStyle = horizontal ? { width: size } : { height: size };

  return (
    <View style={[{ overflow: "hidden" }, windowStyle, anchor, style]}>
      <Animated.View style={[windowStyle, contentStyle]}>{children}</Animated.View>
    </View>
  );
}
