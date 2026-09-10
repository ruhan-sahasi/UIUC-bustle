/**
 * THE crowding vocabulary — glyph, colour, and label for every crowding
 * surface (CrowdingBadge, CrowdingBanner, CrowdingSheet, VehicleMarker).
 *
 * One rule everywhere: colour is never the signal on its own. Each level is a
 * distinctly-SHAPED lucide glyph (seat / riders / standing figure / barred
 * ring — four silhouettes, not four hues) plus a written label; the colour is
 * the theme's AA-audited crowd scale, which is safe as text and border ink on
 * white but still only ever accompanies the glyph and the word.
 *
 * "Estimated" is a status of its own, and the one most easily lost: it gets
 * the neutral `crowd.estimated` token and a slashed-circle glyph that matches
 * no real level, whatever level the schedule guessed.
 */
import { theme } from "@/src/constants/theme";
import type { CrowdingInfo, CrowdingLevel } from "@/src/api/types";
import {
  Armchair,
  Ban,
  CircleSlash,
  PersonStanding,
  Users,
  type LucideIcon,
} from "lucide-react-native";

/**
 * Per-level glyph, chosen for SILHOUETTE rather than hue: a seat, a pair of
 * riders, a standing figure, and a "no entry" ring read as four different
 * shapes at a glance, even in monochrome.
 */
export const CROWD_GLYPHS: Record<CrowdingLevel, LucideIcon> = {
  1: Armchair,
  2: Users,
  3: PersonStanding,
  4: Ban,
};

/** Glyph for "not observed" — a slashed ring that matches no real level. */
export const CROWD_ESTIMATED_GLYPH: LucideIcon = CircleSlash;

export const CROWDING_LABELS: Record<CrowdingLevel, string> = {
  1: "Empty",
  2: "Some seats",
  3: "Standing",
  4: "Full",
};

/** True when there is no observed reading — no data at all, or a schedule guess. */
export function isEstimatedCrowding(info: CrowdingInfo | null | undefined): boolean {
  return !info || info.source === "estimated";
}

/**
 * AA-checked crowding colour from the theme's crowd scale. Missing or
 * estimated readings get the neutral `crowd.estimated` token, as does any
 * level the scale does not know.
 */
export function crowdingColor(info: CrowdingInfo | null | undefined): string {
  if (isEstimatedCrowding(info)) return theme.colors.crowd.estimated;
  return theme.colors.crowd[info!.level] ?? theme.colors.crowd.estimated;
}

/**
 * The glyph for a reading. Missing/estimated readings get the slashed ring —
 * an estimated level is a guess, and drawing the real level's shape for it
 * would erase the one visual difference between observed and inferred.
 */
export function crowdingGlyph(info: CrowdingInfo | null | undefined): LucideIcon {
  if (isEstimatedCrowding(info)) return CROWD_ESTIMATED_GLYPH;
  return CROWD_GLYPHS[info!.level] ?? CROWD_ESTIMATED_GLYPH;
}

export function crowdingLabel(info: CrowdingInfo | null | undefined): string {
  if (!info) return "No data";
  return CROWDING_LABELS[info.level] ?? "Unknown";
}

export function crowdingSourceLabel(info: CrowdingInfo): string {
  if (info.source === "crowdsourced") {
    return `Based on ${info.report_count} recent report${info.report_count === 1 ? "" : "s"}`;
  }
  return "Estimated based on schedule";
}
