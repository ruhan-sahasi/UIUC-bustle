import { SPRING } from "@/src/constants/motion";
import { theme } from "@/src/constants/theme";
import type { CrowdingInfo } from "@/src/api/types";
import { useEffect, useRef } from "react";
import { StyleSheet, Text } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { crowdingColor, crowdingGlyph, crowdingLabel, isEstimatedCrowding } from "@/src/utils/crowding";

interface CrowdingBadgeProps {
  info: CrowdingInfo | null | undefined;
  size?: "sm" | "md";
}

/** How far the chip compresses before springing back on a state change. */
const POP_FROM = 0.88;

/**
 * Crowding chip. Glyph, colour, and label all come from the single crowding
 * vocabulary in `src/utils/crowding.ts`, and colour is never the signal on
 * its own: the glyph and the word both change with the level, and an
 * estimated reading says so in the slashed-ring glyph, the border style, AND
 * its accessibility label.
 *
 * A level or source change springs back with `SPRING.press`, which reduces to
 * an instant swap under the OS reduced-motion setting.
 */
export function CrowdingBadge({ info, size = "sm" }: CrowdingBadgeProps) {
  const color = crowdingColor(info);
  const label = crowdingLabel(info);
  const Glyph = crowdingGlyph(info);
  const isDashed = isEstimatedCrowding(info);

  const scale = useSharedValue(1);
  const mounted = useRef(false);
  // One primitive key, so a level change and a source change both pop exactly once.
  const stateKey = `${info?.level ?? "none"}:${info?.source ?? "none"}`;

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    scale.value = POP_FROM;
    scale.value = withSpring(1, SPRING.press);
  }, [stateKey, scale]);

  useEffect(() => () => cancelAnimation(scale), [scale]);

  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      style={[
        styles.badge,
        size === "md" && styles.badgeMd,
        { borderColor: color, borderStyle: isDashed ? "dashed" : "solid" },
        popStyle,
      ]}
      accessible
      accessibilityLabel={`Crowding: ${label}${isDashed ? ", estimated" : ""}`}
    >
      <Glyph size={size === "md" ? 13 : 11} color={color} strokeWidth={2.4} />
      <Text style={[styles.text, size === "md" && styles.textMd, { color }]}>{label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  badgeMd: {
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.radius.md,
  },
  text: {
    fontFamily: "DMSans_500Medium",
    fontSize: 11,
  },
  textMd: {
    fontSize: 13,
  },
});
