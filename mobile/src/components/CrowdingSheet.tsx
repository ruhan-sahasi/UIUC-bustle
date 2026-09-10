/**
 * CrowdingSheet — "how full is this bus?" report form.
 *
 * ── Presentation ──────────────────────────────────────────────────────────
 * The surface, the drag handle, the detent spring and the backdrop all come
 * from the shared `Sheet` now; this file only supplies content. Two things
 * about that are worth knowing:
 *
 * 1. WHY THERE IS STILL A `Modal`. It is a PORTAL, not the presentation.
 *    `Sheet` positions itself with `StyleSheet.absoluteFill`, so it has to be
 *    mounted somewhere that covers the screen. One of this component's two
 *    call sites satisfies that (map.tsx renders it as a sibling of the
 *    MapView); the other does not — `CrowdingBanner` sits deep inside the home
 *    screen's scrolling content, where an absolutely-positioned sheet would be
 *    laid out against a scrolled inner box and clipped. A transparent
 *    `animationType="none"` Modal gives the sheet a full-screen coordinate
 *    space from either site. The `GestureHandlerRootView` inside it is not
 *    redundant with the app root's: RNGH does not reach across a Modal
 *    boundary, and without it the sheet's pan is dead.
 *
 * 2. THE DETENT IS RAISED ONE FRAME AFTER MOUNT. `Sheet` deliberately does not
 *    animate its first positioning (that would show every sheet sliding in
 *    from nowhere on mount), so opening at index 1 would make this one appear
 *    fully open with no travel. Mounting closed and stepping to the open
 *    detent on the next frame is what turns that into a slide-up. Under
 *    reduced motion the step happens synchronously and `SPRING_D.sheet`'s
 *    `ReduceMotion.System` lands it instantly.
 *
 * The open detent is MEASURED, not guessed: the body reports its own height
 * and the snap fraction follows it. A fixed fraction clips this form on a
 * small phone and leaves a lake of empty surface under the thank-you state,
 * which is a much shorter layout — the measurement is also what makes the
 * sheet shrink to fit after a report lands.
 *
 * ── Colour is never the signal ────────────────────────────────────────────
 * Every level pairs its crowd token with a distinctly-SHAPED glyph (a seat, a
 * pair of riders, a standing figure, a "no entry" ring) and a written label.
 * The glyph map lives in `src/utils/crowding.ts` — the ONE crowding
 * vocabulary shared by every crowding surface — and is re-exported here for
 * existing importers.
 *
 * ── Not touched by the visual pass ────────────────────────────────────────
 * The submit path, the 10-minute client-side cooldown and its AsyncStorage
 * token, and the crowding mutation are exactly as the reliability audit left
 * them. The only addition inside `handleSelect` is feedback: `HAPTIC.commit`
 * when a report lands and `HAPTIC.warn` when it does not, which `Button`
 * documents as the call site's job precisely because only the call site knows
 * whether the request succeeded.
 */
import { theme } from "@/src/constants/theme";
import type { CrowdingLevel } from "@/src/api/types";
import { useSubmitCrowding } from "@/src/queries/crowding";
import { Button } from "@/src/components/ui/Button";
import { Sheet } from "@/src/components/ui/Sheet";
import { CelebrationBurst, fireHaptic, Press, useReducedMotion } from "@/src/components/ui/motion";
import { CROWD_GLYPHS } from "@/src/utils/crowding";
import { Check } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";

const COOLDOWN_KEY_PREFIX = "crowding_cooldown_";
const COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Historical home of the per-level glyph map; it now lives in the single
 * crowding vocabulary (`src/utils/crowding.ts`). Re-exported so existing
 * importers keep working.
 */
export { CROWD_GLYPHS } from "@/src/utils/crowding";

const OPTIONS: { level: CrowdingLevel; label: string; sub: string }[] = [
  { level: 1, label: "Plenty of seats", sub: "Easy to find a spot" },
  { level: 2, label: "Some seats available", sub: "A few open seats" },
  { level: 3, label: "Standing room only", sub: "Bus is packed" },
  { level: 4, label: "Full — no space", sub: "Cannot board" },
];

/** Closed detent, then the measured open one. Ascending, as `Sheet` requires. */
const CLOSED_INDEX = 0;
const OPEN_INDEX = 1;

/**
 * How long the exit spring is given before the Modal host unmounts.
 * `SPRING_D.sheet.duration` is PERCEPTUAL (320ms reads as ~480ms of real
 * tail), but the last stretch of that tail happens with the sheet already off
 * the bottom edge, so waiting the full wall-clock time only delays the
 * backdrop's disappearance.
 */
const EXIT_MS = 360;

/**
 * Whole-minute phrasing for the cooldown, so assistive tech is not handed a
 * string that changes every second. The visible text still ticks in seconds —
 * only the announced label rounds, which is what keeps a focused VoiceOver
 * cursor from re-reading the line once a second.
 */
function cooldownAnnouncement(seconds: number): string {
  const mins = Math.max(1, Math.ceil(seconds / 60));
  return `You can report again in about ${mins} minute${mins === 1 ? "" : "s"}`;
}

/** Snap fraction used until the body has measured itself once. */
const FALLBACK_FRACTION = 0.6;
const MIN_FRACTION = 0.26;
const MAX_FRACTION = 0.92;

interface CrowdingSheetProps {
  visible: boolean;
  vehicleId: string;
  routeId: string;
  tripId?: string;
  onClose: () => void;
}

export function CrowdingSheet({ visible, vehicleId, routeId, tripId, onClose }: CrowdingSheetProps) {
  const { mutateAsync, isPending } = useSubmitCrowding();
  const [submitted, setSubmitted] = useState(false);
  const [cooldownSecs, setCooldownSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CrowdingLevel | null>(null);

  const cooldownKey = `${COOLDOWN_KEY_PREFIX}${vehicleId}`;

  useEffect(() => {
    if (!visible) return;
    setSubmitted(false);
    setError(null);
    AsyncStorage.getItem(cooldownKey).then((val) => {
      if (!val) return;
      const remaining = Math.round((parseInt(val, 10) - Date.now()) / 1000);
      if (remaining > 0) {
        setSubmitted(true);
        setCooldownSecs(remaining);
      }
    });
  }, [visible, cooldownKey]);

  useEffect(() => {
    if (cooldownSecs <= 0) return;
    const t = setInterval(() => setCooldownSecs((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldownSecs]);

  // Visual-only: clear the highlighted option each time the sheet reopens.
  useEffect(() => {
    if (visible) setSelected(null);
  }, [visible]);

  // ── Presentation state. Everything below this line is visual. ───────────

  const reduced = useReducedMotion();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  /** Is the Modal portal mounted? Outlives `visible` by one exit animation. */
  const [hosted, setHosted] = useState(visible);
  const [detent, setDetent] = useState(CLOSED_INDEX);
  const [bodyHeight, setBodyHeight] = useState(0);

  const snapPoints = useMemo(() => {
    if (bodyHeight <= 0 || windowHeight <= 0) return [0, FALLBACK_FRACTION];
    // `theme.layout.tapMin` is the drag handle's fixed height above the body.
    const needed = (bodyHeight + theme.layout.tapMin) / windowHeight;
    return [0, Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, needed))];
  }, [bodyHeight, windowHeight]);

  useEffect(() => {
    if (visible) {
      setHosted(true);
      return;
    }
    setDetent(CLOSED_INDEX);
    if (reduced) {
      setHosted(false);
      return;
    }
    const t = setTimeout(() => setHosted(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [visible, reduced]);

  useEffect(() => {
    if (!hosted || !visible) return;
    // Do not raise until the body has reported its height at least once.
    // The snap fraction is derived from that measurement, and `Sheet` sizes
    // its surface to the largest detent — so raising first and measuring
    // second lets the surface resize part-way through the slide-up, which
    // reads as the sheet hitching. The measurement lands on the layout pass
    // immediately after the portal mounts, so this costs a frame, not a beat.
    if (bodyHeight <= 0) return;
    if (reduced) {
      setDetent(OPEN_INDEX);
      return;
    }
    // One frame later, so `Sheet`'s non-animated first positioning happens at
    // the closed detent and the move to open springs.
    const frame = requestAnimationFrame(() => setDetent(OPEN_INDEX));
    return () => cancelAnimationFrame(frame);
  }, [hosted, visible, reduced, bodyHeight]);

  const handleIndexChange = useCallback(
    (next: number) => {
      setDetent(next);
      if (next === CLOSED_INDEX) onClose();
    },
    [onClose]
  );

  const handleBodyLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    if (measured > 0) setBodyHeight((prev) => (Math.abs(prev - measured) < 1 ? prev : measured));
  }, []);

  async function handleSelect(level: CrowdingLevel) {
    setError(null);
    try {
      await mutateAsync({ vehicle_id: vehicleId, route_id: routeId, trip_id: tripId, crowding_level: level });
      const expiry = Date.now() + COOLDOWN_MS;
      await AsyncStorage.setItem(cooldownKey, String(expiry));
      setCooldownSecs(Math.round(COOLDOWN_MS / 1000));
      setSubmitted(true);
      // HAPTIC.commit — the report landed. `Button` deliberately leaves this to
      // the call site so a failed request never feels like a success.
      fireHaptic("commit");
    } catch (e: any) {
      setError(e.message ?? "Failed to submit. Try again.");
      fireHaptic("warn");
    }
  }

  const fmtCooldown = (s: number) => `${Math.floor(s / 60)}m ${s % 60}s`;

  return (
    <Modal visible={hosted} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.portal}>
        <Sheet
          snapPoints={snapPoints}
          index={detent}
          onIndexChange={handleIndexChange}
          accessibilityLabel={`Report how full route ${routeId} is`}
          // `flex: 0` so the body keeps its natural height and `onLayout`
          // reports the content, not the surface it is measuring itself for.
          contentStyle={styles.sheetContent}
          testID="crowding-sheet"
        >
          <View
            style={[styles.body, { paddingBottom: theme.spacing.lg + insets.bottom }]}
            onLayout={handleBodyLayout}
          >
            <Text style={styles.title} accessibilityRole="header">
              How full is this bus?
            </Text>
            <Text style={styles.subtitle}>Route {routeId} · your report helps other riders</Text>

            {submitted ? (
              <View style={styles.thankYou}>
                <CelebrationBurst count={14} radius={72} style={StyleSheet.absoluteFill} />
                <View style={styles.thankYouGlyph}>
                  <Check size={26} color={theme.colors.successDeep} strokeWidth={2.6} />
                </View>
                <Text style={styles.thankYouText}>Thanks for reporting!</Text>
                {cooldownSecs > 0 && (
                  <Text
                    style={styles.cooldownText}
                    accessibilityLabel={cooldownAnnouncement(cooldownSecs)}
                  >
                    You can report again in {fmtCooldown(cooldownSecs)}
                  </Text>
                )}
              </View>
            ) : (
              <>
                <View accessibilityRole="radiogroup" accessibilityLabel="How full is this bus?">
                  {OPTIONS.map((opt) => {
                    const isSelected = selected === opt.level;
                    const accent = theme.colors.crowd[opt.level];
                    const Glyph = CROWD_GLYPHS[opt.level];
                    return (
                      <Press
                        key={opt.level}
                        variant="scale"
                        scaleTo={0.98}
                        haptic="select"
                        onPress={() => setSelected(opt.level)}
                        disabled={isPending}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: isSelected, selected: isSelected, disabled: isPending }}
                        accessibilityLabel={`${opt.label}. ${opt.sub}`}
                        style={[styles.option, isSelected && styles.optionSelected]}
                      >
                        <View style={[styles.glyphHalo, { borderColor: accent }]}>
                          <Glyph size={17} color={accent} strokeWidth={2.2} />
                        </View>
                        <View style={styles.optionText}>
                          <Text style={styles.optionLabel}>{opt.label}</Text>
                          <Text style={styles.optionSub}>{opt.sub}</Text>
                        </View>
                        <View style={[styles.radio, isSelected && styles.radioSelected]}>
                          {isSelected && (
                            <Check size={13} color={theme.colors.textOnNavy} strokeWidth={3} />
                          )}
                        </View>
                      </Press>
                    );
                  })}
                </View>
                {error && (
                  <Text style={styles.error} accessibilityLiveRegion="polite">
                    {error}
                  </Text>
                )}
                <View style={styles.submitWrap}>
                  <Button
                    label={selected ? "Submit report" : "Select a level to report"}
                    onPress={() => {
                      if (selected) handleSelect(selected);
                    }}
                    variant="primary"
                    loading={isPending}
                    disabled={!selected}
                  />
                </View>
              </>
            )}

            <Press
              variant="tint"
              haptic="tap"
              onPress={onClose}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={styles.closeBtnText}>Close</Text>
            </Press>
          </View>
        </Sheet>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  portal: { flex: 1 },
  sheetContent: { flex: 0 },
  body: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xs,
  },
  title: {
    ...theme.text.title2,
    color: theme.colors.text,
    marginBottom: 2,
  },
  subtitle: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.md,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: 1.5,
    borderColor: theme.colors.borderSoft,
    backgroundColor: theme.colors.surface,
    marginBottom: theme.spacing.sm,
  },
  optionSelected: {
    borderColor: theme.colors.navy,
    backgroundColor: theme.colors.surfaceRaised,
    ...theme.elevation[1],
  },
  glyphHalo: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: { flex: 1 },
  optionLabel: {
    ...theme.text.subhead,
    color: theme.colors.text,
  },
  optionSub: {
    ...theme.text.caption,
    fontSize: 12,
    color: theme.colors.textMuted,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: {
    borderColor: theme.colors.navy,
    backgroundColor: theme.colors.navy,
  },
  error: {
    ...theme.text.caption,
    color: theme.colors.errorDeep,
    marginTop: theme.spacing.sm,
  },
  submitWrap: { marginTop: theme.spacing.md },
  thankYou: { paddingVertical: theme.spacing.lg, alignItems: "center", gap: theme.spacing.sm },
  thankYouGlyph: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.successSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  thankYouText: {
    ...theme.text.heading,
    color: theme.colors.text,
  },
  cooldownText: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    fontVariant: ["tabular-nums"],
  },
  closeBtn: {
    marginTop: theme.spacing.md,
    alignItems: "center",
    borderRadius: theme.radius.lg,
  },
  closeBtnText: {
    ...theme.text.subhead,
    fontSize: 14,
    color: theme.colors.textMuted,
  },
});
