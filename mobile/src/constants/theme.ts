/**
 * UIUC Bustle — Design system v2: "Illini transit signage, alive."
 * Illini navy ground, orange as the signal color, warm white surfaces,
 * DM Serif Display for display type, DM Sans for UI, tabular numerals
 * for anything that ticks. All values here are AA-audited: textMuted
 * passes 4.5:1 on white, textOnNavyMuted passes 4.5:1 on navy, brandInk
 * is the orange for TEXT/ICONS on light surfaces, and ctaEnd is the dark
 * gradient stop that keeps white CTA labels readable.
 */
import { SPRING, SPRING_D, STAGGER, TIMING } from "./motion";

export const theme = {
  colors: {
    orange: "#E84A27",       // brand signal — fills, accents, route lines (NOT text on white)
    orangeBright: "#FF6B3D", // gradient partner / pressed states / glows
    orangeSoft: "#FFF0EA",   // tinted backgrounds behind orange content
    brandInk: "#B03114",     // orange for TEXT & ICONS on light surfaces (>=4.5:1 on white)
    ctaEnd: "#C73B1D",       // dark stop for CTA gradients so white labels pass AA
    navy: "#13294B",         // headers, text, tab bar background
    navyLight: "#1D3D6F",    // secondary backgrounds
    navyDeep: "#0B1B36",     // hero gradient base, tab bar
    surface: "#FFFFFF",
    surfaceAlt: "#F4F5F7",   // screen background, input fill
    surfaceRaised: "#FBFBFD",// subtle raised panels inside cards
    border: "#DDE1E7",       // 1px dividers
    borderSoft: "#EAEDF2",   // even quieter dividers
    text: "#0F1923",
    textSecondary: "#4B5563",
    textMuted: "#5A6779",    // AA muted — 4.5:1+ on white; use for captions/eyebrows
    textOnNavy: "rgba(255,255,255,0.92)",
    textOnNavyMuted: "rgba(255,255,255,0.72)", // AA muted on navy ground
    success: "#16A34A",
    successDeep: "#15803D",  // success as TEXT on light surfaces
    successSoft: "#E8F8EE",
    warning: "#D97706",
    warningDeep: "#92400E",  // warning as TEXT on light surfaces
    warningSoft: "#FEF4E6",
    error: "#DC2626",
    errorDeep: "#B91C1C",    // destructive fills / error TEXT — white label passes AA
    errorSoft: "#FDEDED",
    // Crowding scale — AA-safe as text/border color on white, always pair with glyph+label
    crowd: {
      1: "#1E7B3F",          // Empty
      2: "#8A5A0B",          // Some seats
      3: "#B03114",          // Standing
      4: "#B42318",          // Full
      estimated: "#5A6779",  // No data / estimated
    },
    // Vibrant supporting accents — sparks of color for charts, rings, chips
    sky: "#38BDF8",
    gold: "#FBBF24",
    mint: "#34D399",
    violet: "#8B5CF6",
    // Legacy aliases (used by existing code)
    primary: "#13294B",
    primaryDark: "#0D1E35",
    secondary: "#E84A27",
    accent: "#E84A27",
    card: "#F4F5F7",
    cardBorder: "#DDE1E7",
    background: "#F4F5F7",
  },
  /** Gradient color stops — use with expo-linear-gradient. */
  gradients: {
    hero: ["#0B1B36", "#13294B", "#1D3D6F"] as const,        // deep navy hero headers
    sunset: ["#FF6B3D", "#C73B1D"] as const,                 // primary CTA / FAB — ends on ctaEnd for AA white labels
    sunrise: ["#FF8A5C", "#E84A27", "#C73B1D"] as const,     // big hero CTAs
    ember: ["#1D3D6F", "#13294B"] as const,                  // dark cards
    glowCard: ["#FFFFFF", "#FFF7F4"] as const,               // warm-tinted highlight card
    skyline: ["#38BDF8", "#8B5CF6"] as const,                // activity / fun accents
    mintFresh: ["#34D399", "#38BDF8"] as const,              // success / streak accents
  },
  spacing: {
    xs: 3,
    sm: 6,
    md: 12,
    lg: 20,
    xl: 28,
    xxl: 40,
  },
  /** Shared layout rhythm — spread/read these instead of magic numbers. */
  layout: {
    gutter: 16,
    tapMin: 44,
    cardGap: 12,
    sectionGap: 28,
  },
  radius: {
    xs: 3,
    sm: 5,
    md: 8,
    lg: 12,
    xl: 18,
    xxl: 26,
    pill: 999,
  },
  /** Elevation presets — spread into style objects. */
  shadows: {
    sm: {
      shadowColor: "#13294B",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 3,
      elevation: 1,
    },
    md: {
      shadowColor: "#13294B",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 3,
    },
    lg: {
      shadowColor: "#0B1B36",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.14,
      shadowRadius: 20,
      elevation: 6,
    },
    glowOrange: {
      shadowColor: "#E84A27",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.35,
      shadowRadius: 12,
      elevation: 5,
    },
    glowNavy: {
      shadowColor: "#13294B",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.3,
      shadowRadius: 14,
      elevation: 5,
    },
  },
  /**
   * Numeric elevation ramp 0..3 — ready-to-spread shadow objects.
   * 0 = flat, 1 = resting card, 2 = raised card, 3 = floating/overlay.
   */
  elevation: {
    0: {
      shadowColor: "transparent",
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0,
      shadowRadius: 0,
      elevation: 0,
    },
    1: {
      shadowColor: "#13294B",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 3,
      elevation: 1,
    },
    2: {
      shadowColor: "#13294B",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 10,
      elevation: 3,
    },
    3: {
      shadowColor: "#0B1B36",
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.16,
      shadowRadius: 24,
      elevation: 8,
    },
  },
  /**
   * Motion durations (literal wall-clock ms) shared across animated components,
   * plus the v2 token vocabulary.
   *
   * The legacy `spring` / `springBouncy` configs are gone: their last consumer
   * (the settings segmented control) moved to `v2.SPRING_D.chip`. Spring physics
   * now lives only in src/constants/motion.ts, where every config also carries
   * `reduceMotion`, so a hand-rolled spring cannot silently skip accessibility.
   */
  motion: {
    fast: 160,
    base: 280,
    slow: 450,
    /**
     * Motion vocabulary v2 — re-exported so screens have one import path
     * (`theme.motion.v2.SPRING.press`) instead of two. Canonical definitions
     * and the physics-lane / duration-lane rules live in src/constants/motion.ts;
     * import from there directly when you also need GLIDE or HAPTIC.
     */
    v2: { SPRING, SPRING_D, TIMING, STAGGER },
  },
  /**
   * Type roles — spread one of these instead of hand-rolling sizes.
   * `numeric` and `display` carry tabular-nums so digits align while ticking.
   */
  text: {
    display: {
      fontFamily: "DMSerifDisplay_400Regular",
      fontSize: 34,
      lineHeight: 40,
      fontVariant: ["tabular-nums" as const],
    },
    title1: {
      fontFamily: "DMSerifDisplay_400Regular",
      fontSize: 28,
      lineHeight: 34,
    },
    title2: {
      fontFamily: "DMSerifDisplay_400Regular",
      fontSize: 22,
      lineHeight: 28,
    },
    heading: {
      fontFamily: "DMSans_600SemiBold",
      fontSize: 17,
      lineHeight: 24,
    },
    subhead: {
      fontFamily: "DMSans_600SemiBold",
      fontSize: 15,
      lineHeight: 20,
    },
    body: {
      fontFamily: "DMSans_400Regular",
      fontSize: 15,
      lineHeight: 22,
    },
    caption: {
      fontFamily: "DMSans_400Regular",
      fontSize: 13,
      lineHeight: 18,
    },
    eyebrow: {
      fontFamily: "DMSans_600SemiBold",
      fontSize: 11,
      lineHeight: 14,
      letterSpacing: 1.1,
      textTransform: "uppercase" as const,
    },
    badge: {
      fontFamily: "DMSans_600SemiBold",
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0.3,
    },
    numeric: {
      fontFamily: "DMSans_600SemiBold",
      fontSize: 15,
      lineHeight: 20,
      fontVariant: ["tabular-nums" as const],
    },
  },
  typography: {
    heroTitle:    { fontFamily: "DMSerifDisplay_400Regular", fontSize: 34, lineHeight: 40 },
    displayTitle: { fontFamily: "DMSerifDisplay_400Regular", fontSize: 28, lineHeight: 34 },
    screenTitle:  { fontFamily: "DMSerifDisplay_400Regular", fontSize: 22, lineHeight: 28 },
    heading:      { fontFamily: "DMSans_600SemiBold", fontSize: 17, lineHeight: 24 },
    subheading:   { fontFamily: "DMSans_600SemiBold", fontSize: 15, lineHeight: 20 },
    body:         { fontFamily: "DMSans_400Regular", fontSize: 15, lineHeight: 22 },
    caption:      { fontFamily: "DMSans_400Regular", fontSize: 13, lineHeight: 18 },
    label:        { fontFamily: "DMSans_500Medium", fontSize: 12, lineHeight: 16 },
    // Legacy aliases (used by existing screens before redesign)
    title: { fontFamily: "DMSerifDisplay_400Regular", fontSize: 22, lineHeight: 28 },
  },
};
