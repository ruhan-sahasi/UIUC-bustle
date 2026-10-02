/**
 * AnimatedTabBar — custom bottom tab bar with an orange pill that glides under
 * the active tab.
 *
 * Motion contract (PR 14 re-tune):
 *  - The pill travels on `SPRING.press`, which is overshoot-clamped. A utility
 *    app should not bounce every time you change tabs; the pill arrives and
 *    stops. There is deliberately no file-local spring config any more — the
 *    physics live in `src/constants/motion.ts` so every surface agrees.
 *  - The newly-selected icon POPS: it jumps up one frame and springs back to
 *    its resting size. That single frame is what reads as "the tap landed",
 *    and it costs no waiting time, unlike a sustained bounce.
 *  - `HAPTIC.select` (a selection tick, not a thud) fires ONLY when the tab
 *    actually changes — never on a re-tap of the current tab, and never when
 *    the screen prevents the default.
 *
 * Every token below carries `ReduceMotion.System`, so with "Reduce Motion" on
 * the pill teleports and the icon does not pop — no `if (reduceMotion)` branch
 * required. The one place we still read the live flag is to suppress the pop
 * outright, since a one-frame jump is exactly the kind of thing that setting
 * exists to remove.
 *
 * Accessibility: labels are 11pt and animate COLOR, never opacity — dimming a
 * 0.72-alpha token with a second 0.72 multiplier put inactive labels at ~4.1:1
 * on the light end of the ember gradient, under the AA floor. At full opacity
 * the muted token holds ~6.4:1 and the active orange ~6:1. Every tab is a
 * >= 44pt target with a role, a label, and a selected state.
 */
import { fireHaptic, useReducedMotion } from "@/src/components/ui/motion";
import { SPRING, TIMING } from "@/src/constants/motion";
import { theme } from "@/src/constants/theme";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { LinearGradient } from "expo-linear-gradient";
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Resting scale bump of the focused icon. */
const FOCUS_SCALE = 0.08;
/** Extra scale for the single-frame selection pop, on top of FOCUS_SCALE. */
const POP_SCALE = 0.1;
/** How far the focused icon rises, in px. */
const FOCUS_LIFT = 2;
/**
 * Tab labels are already at the 11pt floor, and they are clipped to one line.
 * Past ~1.4x the label truncates to an ellipsis, which is strictly worse for
 * the user than a slightly smaller-than-requested but complete word.
 */
const LABEL_MAX_SCALE = 1.4;
/** Sentinel for "this value has never been set", so first paint does not animate. */
const UNSET = -1;

function TabIcon({ focused, icon, label }: { focused: boolean; icon: React.ReactNode; label: string }) {
  const reduceMotion = useReducedMotion();
  // Starts UNSET so the initially-focused tab renders at its resting focused
  // size instead of springing up on mount.
  const focus = useSharedValue(UNSET);
  const pop = useSharedValue(0);

  useEffect(() => {
    const current = focus.value;
    const firstPaint = current === UNSET;
    const target = focused ? 1 : 0;
    // Only a REAL focus change pops. This effect also re-runs when the live
    // reduce-motion flag flips, and that must not fire a pop on the tab the
    // user is already sitting on.
    const changed = !firstPaint && current !== target;
    focus.value = firstPaint ? target : withSpring(target, SPRING.press);
    if (changed && focused && !reduceMotion) {
      // One frame at the top, then settle. `duration: 0` is the jump.
      pop.value = withSequence(withTiming(1, { duration: 0 }), withSpring(0, SPRING.press));
    }
  }, [focused, focus, pop, reduceMotion]);

  const iconStyle = useAnimatedStyle(() => {
    // While the value is still UNSET (the mount effect is a passive effect and
    // has not run yet) paint the resting state this tab is already in, or the
    // focused tab flashes one frame at unfocused size.
    const f = focus.value === UNSET ? (focused ? 1 : 0) : focus.value;
    return {
      transform: [{ scale: 1 + f * FOCUS_SCALE + pop.value * POP_SCALE }, { translateY: -f * FOCUS_LIFT }],
    };
  });

  // Color, not opacity: see the AA note in the file header.
  const labelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      focus.value === UNSET ? (focused ? 1 : 0) : focus.value,
      [0, 1],
      [theme.colors.textOnNavyMuted, theme.colors.orangeBright]
    ),
  }));

  return (
    <View style={styles.tabContent}>
      <Animated.View style={iconStyle}>{icon}</Animated.View>
      <Animated.Text
        style={[styles.tabLabel, focused && styles.tabLabelActive, labelStyle]}
        numberOfLines={1}
        maxFontSizeMultiplier={LABEL_MAX_SCALE}
      >
        {label}
      </Animated.Text>
    </View>
  );
}

export function AnimatedTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const [barWidth, setBarWidth] = useState(0);
  const tabCount = state.routes.length;
  const slotWidth = tabCount > 0 ? barWidth / tabCount : 0;

  const indicatorX = useSharedValue(UNSET);
  const indicatorOpacity = useSharedValue(0);
  useEffect(() => {
    if (slotWidth > 0) {
      const target = state.index * slotWidth;
      // The first measured layout places the pill directly — launching onto a
      // deep-linked tab should not start with the pill sliding in from Home.
      // Everything after that (tab change, or a re-layout on rotation) glides.
      indicatorX.value = indicatorX.value === UNSET ? target : withSpring(target, SPRING.press);
      indicatorOpacity.value = withTiming(1, TIMING.base);
    }
  }, [state.index, slotWidth, indicatorX, indicatorOpacity]);

  const indicatorStyle = useAnimatedStyle(() => ({
    opacity: indicatorOpacity.value,
    transform: [{ translateX: Math.max(indicatorX.value, 0) }],
  }));

  return (
    <View
      style={[
        styles.wrapper,
        // Home indicator below, notch/rounded corners at the sides in landscape.
        { paddingBottom: Math.max(insets.bottom, 8), paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      <LinearGradient
        colors={[theme.gradients.ember[0], theme.gradients.ember[1]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={styles.bar}
        accessibilityRole="tablist"
        onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
      >
        {/* Gliding pill indicator */}
        {slotWidth > 0 && (
          <Animated.View style={[styles.indicator, { width: slotWidth }, indicatorStyle]} pointerEvents="none">
            <View style={styles.indicatorPill} />
          </Animated.View>
        )}
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const label = typeof options.title === "string" ? options.title : route.name;
          const focused = state.index === index;
          const color = focused ? theme.colors.orangeBright : theme.colors.textOnNavyMuted;
          const icon = options.tabBarIcon?.({ focused, color, size: 22 });

          return (
            <Pressable
              key={route.key}
              style={styles.tab}
              // "tab" + tablist lets VoiceOver announce "Schedule, tab, 2 of 5".
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
              testID={options.tabBarButtonTestID}
              onPress={() => {
                const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) {
                  // Moving between discrete options — a selection tick, and only
                  // on an actual change.
                  fireHaptic("select");
                  navigation.navigate(route.name, route.params);
                }
              }}
              onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
            >
              <TabIcon focused={focused} icon={icon} label={label} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: "hidden",
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    backgroundColor: theme.colors.navyDeep,
    ...theme.shadows.lg,
  },
  bar: {
    flexDirection: "row",
    height: 64,
    alignItems: "stretch",
  },
  indicator: {
    position: "absolute",
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 7,
  },
  indicatorPill: {
    width: 48,
    height: 33,
    borderRadius: theme.radius.pill,
    backgroundColor: "rgba(232,74,39,0.18)",
    borderWidth: 1,
    borderColor: "rgba(255,107,61,0.35)",
  },
  tab: {
    flex: 1,
    minHeight: theme.layout.tapMin,
    alignItems: "center",
    justifyContent: "center",
  },
  tabContent: {
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  tabLabel: {
    fontFamily: "DMSans_500Medium",
    fontSize: 11,
    color: theme.colors.textOnNavyMuted,
  },
  // Weight only — the color is driven by `labelStyle` so it can crossfade.
  tabLabelActive: {
    fontFamily: "DMSans_600SemiBold",
  },
});
