/**
 * UIUC Bustle — motion token vocabulary (v2).
 *
 * One place where "how fast, how bouncy, how loud" is decided, so screens
 * describe INTENT (`SPRING.press`) instead of physics (`{ damping: 110, ... }`).
 *
 * ── Why there are two spring lanes ────────────────────────────────────────
 * Reanimated's `SpringConfig` is a DISCRIMINATED UNION. You may specify a
 * spring either by physics (`damping` / `mass` / `stiffness`) or by perceived
 * time (`duration` / `dampingRatio`) — never both. The union literally types
 * the opposite lane's keys as `never`, so mixing them is a compile error, and
 * merging the two objects at a call site (`{ ...SPRING.press, ...SPRING_D.sheet }`)
 * will not typecheck. That is intentional; it is a real API constraint, not a
 * lint rule.
 *
 *   SPRING    — physics lane. Use for anything driven by a gesture or by a
 *               value that can be interrupted mid-flight: press states,
 *               settling back to rest, arrival celebration. Physics springs
 *               retarget gracefully because velocity carries over.
 *   SPRING_D  — duration lane. Use when a designer specified a time budget and
 *               the motion is a discrete, uninterrupted commit: a sheet
 *               detent, a chip swap.
 *
 * ── `duration` here is PERCEPTUAL ─────────────────────────────────────────
 * In Reanimated 4, `duration` on a spring is the *perceived* settle time; the
 * real wall-clock tail is roughly 1.5x that. `SPRING_D.sheet.duration = 320`
 * therefore reads as ~320ms and actually finishes near ~480ms. Do not compare
 * these numbers to `TIMING.*` durations, which are literal wall-clock ms.
 *
 * ── Reduced motion is structural, not conditional ─────────────────────────
 * EVERY config below carries `reduceMotion: ReduceMotion.System`, so Reanimated
 * jumps straight to the target value whenever its global reduce-motion flag is
 * set. Accessibility degrades by construction: no screen can regress by
 * forgetting an `if (reduceMotion)` branch.
 *
 * That guarantee holds because `app/_layout.tsx` keeps Reanimated's flag in
 * sync — NOT because `System` polls the OS. `ReduceMotion.System` is resolved
 * against `ReducedMotionManager.uiValue`, and that mutable is seeded exactly
 * once, at module load:
 *
 *   // node_modules/react-native-reanimated/lib/module/ReducedMotion.js
 *   const IS_REDUCED_MOTION_ENABLED_IN_SYSTEM = isReducedMotionEnabledInSystem();
 *   export const ReducedMotionManager = { uiValue: makeMutable(IS_...), ... };
 *
 * Nothing re-reads the OS after that, so on its own `System` would freeze at
 * whatever the setting was when the bundle loaded. The root layout therefore
 * mounts ONE `<ReducedMotionConfig>` whose mode is driven by the live,
 * AccessibilityInfo-backed `useReducedMotion` from
 * `src/components/ui/motion.tsx`; that is what makes a mid-session toggle take
 * effect. Two rules follow:
 *   - Never mount a second `ReducedMotionConfig` anywhere else. Each one
 *     restores the flag it captured on mount when it unmounts or when its
 *     `mode` changes, so two of them clobber each other.
 *   - Never pass `ReduceMotion.System` to `ReducedMotionConfig` — it would just
 *     re-read the same stale snapshot.
 *
 * Note: Reanimated's own `useReducedMotion()` snapshots the setting at module
 * import and never updates. When a component needs to *read* the flag in JS
 * (to swap copy, skip a haptic, or render a static frame), use the live
 * AccessibilityInfo-backed `useReducedMotion` in `src/components/ui/motion.tsx`.
 */
import { useSyncExternalStore } from "react";
import { Easing, ReduceMotion, type WithSpringConfig, type WithTimingConfig } from "react-native-reanimated";

/**
 * Physics lane — `damping` / `mass` / `stiffness`.
 * Never add `duration` or `dampingRatio` to these objects (see file header).
 *
 * Values sit on Reanimated 4's `mass: 4, stiffness: 900` family, which is
 * tuned so damping alone reads as a personality dial: 110 snappy, 120 gentle,
 * 90 wiggly.
 */
export const SPRING = {
  /**
   * Press / release of a tappable surface. `overshootClamping` keeps a pressed
   * card from springing past its rest scale, which reads as sloppy on a
   * control the finger is still touching.
   */
  press: {
    damping: 110,
    mass: 4,
    stiffness: 900,
    overshootClamping: true,
    reduceMotion: ReduceMotion.System,
  },
  /**
   * The default. Anything returning to rest, reflowing, or retargeting
   * mid-flight: list settle, map recenter, sheet snap-back.
   */
  settle: {
    damping: 120,
    mass: 4,
    stiffness: 900,
    reduceMotion: ReduceMotion.System,
  },
  /**
   * Deliberately underdamped — it overshoots and wobbles.
   * ARRIVAL ONLY (bus arrived, streak earned, goal hit). Using this for
   * ordinary UI makes the whole app feel unserious, and it is the one config
   * here that costs the user real waiting time.
   */
  joy: {
    damping: 90,
    mass: 4,
    stiffness: 900,
    reduceMotion: ReduceMotion.System,
  },
} satisfies Record<"press" | "settle" | "joy", WithSpringConfig>;

/**
 * Duration lane — `duration` (PERCEPTUAL ms) / `dampingRatio`.
 * Never add `damping` / `mass` / `stiffness` to these objects.
 *
 * `dampingRatio`: 1 is critically damped (no overshoot), < 1 overshoots,
 * > 1 is sluggish.
 */
export const SPRING_D = {
  /**
   * Bottom-sheet detent changes. 0.92 leaves a whisper of overshoot so the
   * sheet feels physical, and `overshootClamping` still prevents the top edge
   * from crossing the detent and revealing a seam.
   */
  sheet: {
    duration: 320,
    dampingRatio: 0.92,
    overshootClamping: true,
    reduceMotion: ReduceMotion.System,
  },
  /**
   * Filter chips, segmented controls, small badges. Critically damped: a chip
   * that overshoots looks like a bug because the label is still readable
   * during the wobble.
   */
  chip: {
    duration: 220,
    dampingRatio: 1,
    reduceMotion: ReduceMotion.System,
  },
} satisfies Record<"sheet" | "chip", WithSpringConfig>;

/**
 * Timing lane — literal wall-clock ms plus an easing curve. Use for things a
 * spring cannot express: opacity crossfades, color transitions, progress
 * sweeps, anything where the end time must be predictable.
 *
 * Durations intentionally match the legacy `theme.motion.fast/base/slow`
 * (160 / 280 / 450) so v1 and v2 surfaces stay visually coherent while the
 * codebase migrates.
 */
export const TIMING = {
  /** Immediate feedback — a value ticking, an icon crossfading. */
  fast: {
    duration: 160,
    easing: Easing.out(Easing.quad),
    reduceMotion: ReduceMotion.System,
  },
  /** The default timing curve. Emphasized decelerate: fast out, soft landing. */
  base: {
    duration: 280,
    easing: Easing.bezier(0.2, 0, 0, 1),
    reduceMotion: ReduceMotion.System,
  },
  /** Large or full-screen changes: hero reveals, backdrop dims, route draws. */
  slow: {
    duration: 450,
    easing: Easing.inOut(Easing.cubic),
    reduceMotion: ReduceMotion.System,
  },
} satisfies Record<"fast" | "base" | "slow", WithTimingConfig>;

/**
 * Stagger — per-item entrance delay, in ms.
 *
 * The caps matter more than the steps: without them, item 30 of a list waits
 * 30 x step before appearing, which reads as the app hanging. Always compute
 * `Math.min(index, cap) * step`, never `index * step`.
 *
 * `step`/`cap` are for small clusters (a card's chips, a header's stats);
 * `listStep`/`listCap` are for scrolling lists, slightly tighter because more
 * items are in flight at once.
 */
export const STAGGER = {
  step: 45,
  cap: 6,
  listStep: 40,
  listCap: 8,
} as const;

/**
 * Glide — durations (ms) for continuous, data-driven interpolation rather
 * than UI reactions. These are the windows over which a value is smoothed
 * toward freshly arrived data, so they are tuned against the poll interval:
 * long enough to hide jitter, short enough that the pixel never lies about
 * where the bus is.
 */
export const GLIDE = {
  /** Vehicle puck sliding between GPS fixes. */
  vehicle: 900,
  /** Map marker / cluster repositioning. */
  marker: 600,
  /** Chart series morphing to a new dataset. */
  chart: 700,
  /** Route polyline redraw / reshape. */
  route: 850,
} as const;

/**
 * Haptics — intent names mapped to expo-haptics primitives.
 *
 * The string values are exactly the values expo-haptics uses
 * (`ImpactFeedbackStyle` / `NotificationFeedbackType`), plus `'selection'`
 * for `Haptics.selectionAsync()`. Screens should pass a `HapticKey` to the
 * shared haptic helper rather than calling expo-haptics directly, so a single
 * place can honor the user's haptics preference and reduced-motion state.
 */
export const HAPTIC = {
  /** Any ordinary tap on a control. */
  tap: "light",
  /** Sheet crossed a detent boundary. */
  detent: "light",
  /** Moved between discrete options (segmented control, picker, chip row). */
  select: "selection",
  /** A real state change landed: saved, favorited, alarm set. */
  commit: "medium",
  /** Arrival / goal reached — pairs with SPRING.joy. */
  arrive: "success",
  /** Degraded state: stale data, no GPS, request failed but recoverable. */
  warn: "warning",
} as const;

export type HapticKey = keyof typeof HAPTIC;

/**
 * ── Developer override: "force reduced motion" ────────────────────────────
 *
 * Written by the Developer toggle in `app/(tabs)/settings.tsx`, read by
 * `app/_layout.tsx`, which ORs it with the live system setting to pick the mode
 * of the app's single `<ReducedMotionConfig>` (see the header note above).
 *
 * Why the flag lives here rather than in the settings screen: the root layout is
 * the one owner of Reanimated's global flag, and it needs both inputs in the
 * same render. Two `ReducedMotionConfig`s — one per input — fight, because each
 * restores the value it captured on mount.
 *
 * Deliberately NOT persisted: a debug switch that survives a restart is a debug
 * switch someone forgets is on. Deliberately not a new state library either —
 * this is the same `useSyncExternalStore` shape `useReducedMotion` already uses
 * in `src/components/ui/motion.tsx`.
 */
let devForcedReducedMotion = false;
const devForcedListeners = new Set<() => void>();

function subscribeDevForcedReducedMotion(listener: () => void): () => void {
  devForcedListeners.add(listener);
  return () => {
    devForcedListeners.delete(listener);
  };
}

function getDevForcedReducedMotion(): boolean {
  return devForcedReducedMotion;
}

/** Flip the developer override. No-op in release builds. */
export function setDevForcedReducedMotion(next: boolean): void {
  if (!__DEV__ || next === devForcedReducedMotion) return;
  devForcedReducedMotion = next;
  devForcedListeners.forEach((listener) => listener());
}

/** Live value of the developer override. Always `false` in release builds. */
export function useDevForcedReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeDevForcedReducedMotion,
    getDevForcedReducedMotion,
    getDevForcedReducedMotion
  );
}
