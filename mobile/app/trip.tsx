import { fetchDepartures } from "@/src/api/client";
import type { DepartureItem } from "@/src/api/types";
import { Badge } from "@/src/components/ui/Badge";
import { DepartureRow } from "@/src/components/ui/DepartureRow";
import { EmptyState } from "@/src/components/ui/EmptyState";
import { SectionHeader } from "@/src/components/ui/SectionHeader";
import { FadeInView, PressableScale, Skeleton, Stagger } from "@/src/components/ui/motion";
import { STAGGER } from "@/src/constants/motion";
import { theme } from "@/src/constants/theme";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { departureKeys } from "@/src/utils/departureKey";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Bus, CloudOff, Footprints } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

const REFRESH_INTERVAL_MS = 25000;

// ── Route gradient identity ───────────────────────────────────────────────
/**
 * ROUTE_GRADIENT — one stable gradient per route id.
 *
 * Reanimated 4.1.7 has no shared-element transition (`sharedTransitionTag` and
 * `SharedTransition` do not exist in this version, at any import path). The
 * continuity trick instead is IDENTITY, not morphing: a route always paints
 * itself with the same gradient, so the surface you tapped and the header you
 * land on read as the same object even though nothing actually animated
 * between the two screens. Content then staggers in on top of that held
 * backdrop, which is what sells it as one continuous thing.
 *
 * Every triple here is deliberately DARK. The header renders
 * `textOnNavy` / `textOnNavyMuted` over it, so the lightest stop in each triple
 * is held near or below the luminance of `theme.colors.navyLight` — white type
 * clears 4.5:1 on all six. `theme.gradients.skyline` / `.mintFresh` / `.sunrise`
 * are NOT in the pool for exactly this reason: they are gorgeous and they would
 * put 92%-white text on #38BDF8 at roughly 1.9:1.
 *
 * NOTE(cross-screen): the second half of "the same gradient in both places"
 * cannot be wired from this file yet. See the PR summary — no route card in
 * the tree carries a gradient, and nothing routes into /trip with a route id.
 * When that lands, this map moves to src/constants/ verbatim and both sides
 * import it; keep `routeGradient` pure so that move stays a cut-and-paste.
 */
const ROUTE_GRADIENTS: readonly (readonly [string, string, string])[] = [
  ["#0B1B36", "#13294B", "#1D3D6F"], // illini navy (matches theme.gradients.hero)
  ["#2A1207", "#5A2410", "#7A3418"], // deep ember
  ["#1B1035", "#2E1A5C", "#3F2483"], // deep violet
  ["#04212B", "#07384A", "#0A4C64"], // deep teal
  ["#062015", "#0B3A25", "#0F4E31"], // deep moss
  ["#2A0A1E", "#4A1234", "#631846"], // deep plum
] as const;

/** Neutral backdrop for "this board has no route identity yet". */
const NEUTRAL_GRADIENT = ROUTE_GRADIENTS[0];

/**
 * Deterministic route id -> gradient. Pure and stable across launches: the
 * same route must land on the same gradient every time or the continuity
 * illusion breaks the second the user comes back to a screen.
 */
function routeGradient(routeId?: string | null): readonly [string, string, string] {
  if (!routeId) return NEUTRAL_GRADIENT;
  let hash = 0;
  for (let i = 0; i < routeId.length; i++) {
    hash = (hash * 31 + routeId.charCodeAt(i)) | 0;
  }
  return ROUTE_GRADIENTS[Math.abs(hash) % ROUTE_GRADIENTS.length];
}

/** Render-only placeholder row while the departure board loads. */
function DepartureRowSkeleton() {
  return (
    <View style={styles.skeletonRow}>
      <Skeleton width={44} height={20} radius={theme.radius.pill} />
      <View style={styles.skeletonMiddle}>
        <Skeleton width="72%" height={14} />
      </View>
      <Skeleton width={48} height={16} />
    </View>
  );
}

/**
 * Render-only wrapper: a DepartureRow with its route's gradient showing as a
 * hairline stripe down the leading edge.
 *
 * This is what makes the header's tint legible as a route rather than as
 * decoration — the top row's stripe and the header behind it are the same
 * hue. Purely additive: the stripe is decorative, hidden from assistive tech,
 * and never the only carrier of meaning (the route is already a text Badge
 * inside the row, and delay/live state are already text chips).
 */
function RouteIdentityRow({ departure }: { departure: DepartureItem }) {
  const stripe = routeGradient(departure.route)[2];
  return (
    <View style={styles.identityRow}>
      <View
        style={[styles.identityStripe, { backgroundColor: stripe }]}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <DepartureRow
        route={departure.route}
        headsign={departure.headsign || "—"}
        expectedMins={departure.expected_mins}
        isRealtime={departure.is_realtime}
        expectedTimeIso={departure.expected_time_iso}
        delayStatus={departure.delay_status}
        delayMins={departure.delay_mins}
      />
    </View>
  );
}

export default function TripScreen() {
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const { stop_id, stop_name } = useLocalSearchParams<{ stop_id: string; stop_name?: string }>();
  const router = useRouter();
  const [departures, setDepartures] = useState<DepartureItem[]>([]);
  const keys = useMemo(() => departureKeys(departures), [departures]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!stop_id) return;
    setLoadError(false);
    try {
      const res = await fetchDepartures(apiBaseUrl, stop_id, 60, { apiKey: apiKey ?? undefined });
      setDepartures((res.departures ?? []).slice(0, 15));
    } catch {
      setDepartures([]);
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiBaseUrl, apiKey, stop_id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!stop_id) return;
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [stop_id, load]);

  const onWalkInstead = useCallback(() => {
    router.replace("/(tabs)?highlight=walk" as any);
  }, [router]);

  // Render-only derivation, deliberately not a hook: the board takes its
  // identity from the next bus listed, and falls back to neutral navy when
  // there is nothing to take it from.
  const headerGradient = departures.length > 0 ? routeGradient(departures[0].route) : NEUTRAL_GRADIENT;

  if (!stop_id) {
    return (
      <View style={styles.centered}>
        <EmptyState
          icon={Bus}
          title="Missing stop"
          subtitle="This departure board was opened without a stop."
          action={{ label: "Go back", onPress: () => router.back() }}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
          tintColor={theme.colors.navy}
          colors={[theme.colors.brandInk]}
          progressBackgroundColor={theme.colors.surface}
        />
      }
    >
      <FadeInView delay={0} style={styles.board}>
        {/*
          The header wears the LEAD departure's gradient, so the board is
          tinted by the bus you are actually waiting for and matches that row's
          edge stripe below. Falls back to the neutral navy while loading,
          erroring, or empty — a board with no departures has no route identity
          to borrow.

          Derived during render on purpose: no extra hook, nothing added to
          this screen's audited hook list. The swap on a lead-route change is
          instantaneous rather than crossfaded, which is fine because all six
          gradients sit at the same darkness — it reads as a hue shift, not a
          flash. Do NOT drive this from a scroll or gesture value.
        */}
        <LinearGradient
          colors={[headerGradient[0], headerGradient[1], headerGradient[2]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.boardHeader}
        >
          <Text style={styles.eyebrow}>Departure board</Text>
          <Text style={styles.stopName} accessibilityRole="header">
            {stop_name || stop_id}
          </Text>
          <View style={styles.accentUnderline} />
          <View style={styles.liveRow}>
            <Badge label="LIVE" variant="live" size="sm" />
            <Text style={styles.subtitle}>Updates every 25 seconds</Text>
          </View>
        </LinearGradient>

        <View style={styles.boardBody}>
          {loading ? (
            <View accessibilityLabel="Loading departures">
              <Stagger step={STAGGER.listStep} cap={STAGGER.listCap} dy={8}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <DepartureRowSkeleton key={i} />
                ))}
              </Stagger>
            </View>
          ) : loadError ? (
            <EmptyState
              icon={CloudOff}
              title="Couldn't load departures"
              subtitle="Check your connection, then pull down or tap to retry."
              action={{ label: "Try again", onPress: load }}
            />
          ) : departures.length === 0 ? (
            <EmptyState
              icon={Bus}
              title="No departures right now"
              subtitle="Nothing is scheduled from this stop in the next hour."
            />
          ) : (
            <View>
              <SectionHeader title="Next departures" />
              {/*
                Stagger instead of `delay={i * 55}`: with 15 rows the old ladder
                put the last row 770ms out, which reads as the board hanging.
                STAGGER.listCap holds the worst case near 320ms.

                Keys stay index-based, exactly as before. `entering` only fires
                on mount, so reusing the same keys across the 25s refresh is
                what keeps the board from re-animating every poll.
              */}
              <Stagger step={STAGGER.listStep} cap={STAGGER.listCap} dy={10}>
                {departures.map((d, i) => (
                  <RouteIdentityRow key={keys[i]} departure={d} />
                ))}
              </Stagger>
            </View>
          )}
        </View>
      </FadeInView>

      <FadeInView delay={140}>
        <PressableScale
          accessibilityLabel="I'll walk instead, go back to Home"
          accessibilityRole="button"
          onPress={onWalkInstead}
          style={styles.walkBtn}
        >
          <Footprints size={18} color={theme.colors.navy} strokeWidth={2.2} />
          <Text style={styles.walkBtnText}>I'll walk instead</Text>
        </PressableScale>
      </FadeInView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: "center",
    padding: theme.layout.gutter,
    backgroundColor: theme.colors.surfaceAlt,
  },
  screen: { backgroundColor: theme.colors.surfaceAlt },
  container: {
    padding: theme.layout.gutter,
    paddingBottom: theme.layout.sectionGap + 4,
  },
  board: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    marginBottom: theme.layout.sectionGap - 8,
    overflow: "hidden",
    ...theme.elevation[2],
  },
  boardHeader: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg + 2,
    paddingBottom: theme.spacing.lg - 2,
  },
  eyebrow: {
    ...theme.text.eyebrow,
    color: theme.colors.textOnNavyMuted,
    marginBottom: theme.spacing.sm,
  },
  stopName: {
    ...theme.text.title1,
    color: theme.colors.textOnNavy,
  },
  accentUnderline: {
    width: 44,
    height: 3,
    borderRadius: theme.radius.pill,
    // Gold, not `orange`. This bar used to sit on the fixed navy hero, where
    // orange read as a signal mark. The header hue is now route-derived, and
    // on the deep-ember triple (#2A1207 → #7A3418) brand orange lands at
    // roughly 3:1 against its own background and effectively disappears.
    // Gold is the one palette accent with high enough luminance to separate
    // from all six gradients, and it already carries "numeric accent on a dark
    // ground" elsewhere in the app.
    backgroundColor: theme.colors.gold,
    marginTop: 8,
    marginBottom: 12,
  },
  liveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  subtitle: {
    ...theme.text.caption,
    color: theme.colors.textOnNavyMuted,
  },
  boardBody: {
    paddingBottom: theme.spacing.sm,
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    minHeight: theme.layout.tapMin,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSoft,
  },
  skeletonMiddle: { flex: 1 },
  identityRow: {
    position: "relative",
  },
  identityStripe: {
    position: "absolute",
    left: 0,
    top: 0,
    // Stops short of the row's own 1px bottom divider so the stripes read as
    // separate marks per row rather than one continuous rail.
    bottom: 1,
    width: 3,
    zIndex: 1,
  },
  walkBtn: {
    minHeight: theme.layout.tapMin,
    flexDirection: "row",
    gap: theme.spacing.sm,
    padding: theme.spacing.md + 2,
    borderRadius: theme.radius.lg,
    borderWidth: 1.5,
    borderColor: theme.colors.navy,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
    ...theme.elevation[1],
  },
  walkBtnText: {
    ...theme.text.subhead,
    fontSize: 16,
    color: theme.colors.navy,
  },
});
