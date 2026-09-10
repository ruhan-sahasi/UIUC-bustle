/**
 * CrowdingBanner — the one-line crowding readout above a bus recommendation,
 * and the entry point to reporting one.
 *
 * ── Status is written down, three times over ──────────────────────────────
 * The crowd tokens (`theme.colors.crowd`) are AA-safe as text and border ink,
 * but they are still only hue. So a level is carried by a SHAPE
 * (`crowdingGlyph` — seat / riders / standing figure / barred ring), by a
 * WORD (`crowdingLabel`), and by a second line saying where the reading came
 * from — all three read from the single crowding vocabulary in
 * `src/utils/crowding.ts`. Strip the colour out entirely and the banner still
 * says exactly the same thing; that is the test it has to pass.
 *
 * "Estimated" is a status too, and it is the one most easily lost. It gets the
 * neutral `crowd.estimated` token, a slashed-circle glyph that matches no real
 * level, and `crowdingSourceLabel`'s own sentence.
 *
 * ── Tap target ────────────────────────────────────────────────────────────
 * `Press` rather than `PressableScale`: it enforces the 44pt floor and a
 * declared role at compile time, which is what a whole-row control that opens
 * a reporting sheet needs.
 */
import { theme } from "@/src/constants/theme";
import { useCrowding } from "@/src/queries/crowding";
import { crowdingColor, crowdingGlyph, crowdingLabel, crowdingSourceLabel } from "@/src/utils/crowding";
import { Press } from "@/src/components/ui/motion";
import { ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CrowdingSheet } from "./CrowdingSheet";

interface CrowdingBannerProps {
  vehicleId: string;
  routeId: string;
  tripId?: string;
}

export function CrowdingBanner({ vehicleId, routeId, tripId }: CrowdingBannerProps) {
  const { data: crowding, isLoading } = useCrowding(vehicleId, routeId);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (isLoading) return null;

  const accentColor = crowdingColor(crowding);
  const label = crowdingLabel(crowding);
  const sourceLabel = crowding ? crowdingSourceLabel(crowding) : "No crowding data yet";
  const Glyph = crowdingGlyph(crowding);

  return (
    <>
      <Press
        variant="lift"
        haptic="tap"
        style={[styles.banner, { borderLeftColor: accentColor }]}
        onPress={() => setSheetOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Crowding: ${label}. ${sourceLabel}. Report crowding`}
      >
        <View style={[styles.glyphHalo, { borderColor: accentColor }]}>
          <Glyph size={16} color={accentColor} strokeWidth={2.2} />
        </View>

        <View style={styles.left}>
          <Text style={[styles.status, { color: accentColor }]} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.source} numberOfLines={1}>
            {sourceLabel}
          </Text>
        </View>

        <View style={styles.report}>
          <Text style={styles.reportText}>Report</Text>
          <ChevronRight size={14} color={theme.colors.brandInk} strokeWidth={2.4} />
        </View>
      </Press>

      <CrowdingSheet
        visible={sheetOpen}
        vehicleId={vehicleId}
        routeId={routeId}
        tripId={tripId}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderLeftWidth: 4,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginHorizontal: theme.spacing.lg,
    marginVertical: theme.spacing.xs,
    ...theme.elevation[1],
  },
  glyphHalo: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  left: { flex: 1, gap: 1 },
  status: {
    ...theme.text.subhead,
    fontSize: 14,
  },
  source: {
    ...theme.text.caption,
    fontSize: 12,
    color: theme.colors.textMuted,
  },
  report: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  reportText: {
    ...theme.text.subhead,
    fontSize: 13,
    color: theme.colors.brandInk,
  },
});
