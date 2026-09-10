import { fetchAllStopsForRoute, fetchVehicles } from "@/src/api/client";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { STAGGER } from "@/src/constants/motion";
import { theme } from "@/src/constants/theme";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AlertTriangle, Bus, MapPinOff } from "lucide-react-native";
import { Badge } from "@/src/components/ui/Badge";
import { EmptyState } from "@/src/components/ui/EmptyState";
import { AnimatedNumber, FadeInView, PulseView, RouteProgress, Skeleton, Stagger } from "@/src/components/ui/motion";

const VEHICLE_POLL_MS = 10_000;

interface BusStop {
  stop_id: string;
  stop_name: string;
  lat: number;
  lng: number;
  sequence: number;
}

interface Vehicle {
  vehicle_id: string;
  lat: number;
  lng: number;
  route_id: string;
  heading?: number;
}

// Fixed row height keeps the drawn route line's geometry exact: the line runs
// from the first dot center to the last dot center with no per-row measuring.
const ROW_H = 64;
const RAIL_W = 40;
const LIST_PAD_TOP = 8;
// RouteProgress pads its viewBox by max(strokeWidth, dotRadius) + 2.
const LINE_STROKE = 3;
const LINE_DOT_R = 4;
const LINE_PAD = Math.max(LINE_STROKE, LINE_DOT_R) + 2;

/**
 * The one "this data is arriving live" mark on this screen: a steady dot with a
 * pulsing halo behind it. The halo is a `PulseView`, so it stops on its own
 * under reduced motion and the dot underneath still reads as present — the
 * liveness is never carried by the animation alone.
 */
function LiveDot({ small = false }: { small?: boolean }) {
  return (
    <View style={small ? styles.liveDotWrapSm : styles.liveDotWrap}>
      <PulseView
        minOpacity={0.3}
        maxScale={1.7}
        style={small ? styles.liveDotHaloSm : styles.liveDotHalo}
      />
      <View style={small ? styles.liveDotSm : styles.liveDot} />
    </View>
  );
}

/**
 * Render-only stop timeline: a self-drawing route line down the rail, quiet
 * stop dots, and a pulsing bus marker (glyph + "Bus here" text, never
 * color-only) wherever a live vehicle is near a stop.
 */
function StopTimeline({ stops, vehicles }: { stops: BusStop[]; vehicles: Vehicle[] }) {
  const railCenterX = theme.layout.gutter + RAIL_W / 2;
  const lineLength = ROW_H * (stops.length - 1);
  return (
    <View style={styles.stopList}>
      {stops.length > 1 && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: railCenterX - LINE_PAD,
            top: LIST_PAD_TOP + ROW_H / 2 - LINE_PAD,
          }}
        >
          <RouteProgress
            points={[{ x: 0, y: 0 }, { x: 0, y: lineLength }]}
            color={theme.colors.orange}
            trackColor={theme.colors.borderSoft}
            strokeWidth={LINE_STROKE}
            dotRadius={LINE_DOT_R}
            showDot={false}
            duration={1600}
          />
        </View>
      )}
      {/*
        A scrolling list, so it enters on the list cadence (`listStep`/`listCap`)
        rather than the tighter cluster cadence. The cap is what keeps stop 30 of
        a long route from waiting more than a beat to appear.

        The drawn rail line stays a SIBLING of this Stagger, not a child: it is
        absolutely positioned against `stopList`, and wrapping it in an entrance
        view would reparent it onto a zero-height wrapper and pull the line off
        the dots.
      */}
      <Stagger step={STAGGER.listStep} cap={STAGGER.listCap}>
        {stops.map((stop, i) => {
          const isFirst = i === 0;
          const isLast = i === stops.length - 1;
          // Find if any vehicle is near this stop (within ~200m)
          const hasVehicleNearby = vehicles.some((v) => {
            const dlat = v.lat - stop.lat;
            const dlng = v.lng - stop.lng;
            return Math.sqrt(dlat * dlat + dlng * dlng) * 111_000 < 200;
          });

          return (
            <View key={stop.stop_id} style={styles.stopRow}>
              <View style={styles.rail}>
                {hasVehicleNearby ? (
                  <View style={styles.busDotWrap}>
                    <PulseView minOpacity={0.25} maxScale={1.5} style={styles.busDotHalo} />
                    <View style={styles.busDot}>
                      <Bus size={12} color={theme.colors.surface} strokeWidth={2.5} />
                    </View>
                  </View>
                ) : (
                  <View style={[styles.stopDot, (isFirst || isLast) && styles.stopDotTerminus]} />
                )}
              </View>
              <View style={[styles.stopInfo, !isLast && styles.stopInfoDivider]}>
                <Text
                  style={[styles.stopName, (isFirst || isLast) && styles.stopNameTerminus]}
                  numberOfLines={1}
                >
                  {stop.stop_name}
                </Text>
                {(isFirst || isLast) && (
                  <Text style={styles.stopMeta}>{isFirst ? "First stop" : "Last stop"}</Text>
                )}
                {hasVehicleNearby && (
                  <View style={styles.busHereChip} accessible accessibilityLabel="Bus at this stop now">
                    <Bus size={11} color={theme.colors.brandInk} strokeWidth={2.4} />
                    <Text style={styles.busHereText}>Bus here now</Text>
                  </View>
                )}
              </View>
            </View>
          );
        })}
      </Stagger>
    </View>
  );
}

export default function RouteTrackerScreen() {
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const { route_id, route_name } = useLocalSearchParams<{ route_id: string; route_name?: string }>();
  const router = useRouter();

  const [stops, setStops] = useState<BusStop[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vehicleIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStops = useCallback(async () => {
    if (!route_id) return;
    setError(null);
    try {
      const res = await fetchAllStopsForRoute(apiBaseUrl, route_id, { apiKey: apiKey ?? undefined });
      setStops(res.stops ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load route");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiBaseUrl, apiKey, route_id]);

  const loadVehicles = useCallback(async () => {
    if (!route_id) return;
    try {
      const res = await fetchVehicles(apiBaseUrl, route_id, { apiKey: apiKey ?? undefined });
      setVehicles((res.vehicles ?? []) as Vehicle[]);
    } catch {
      // Vehicle data is best-effort
    }
  }, [apiBaseUrl, apiKey, route_id]);

  useEffect(() => {
    loadStops();
    loadVehicles();
  }, [loadStops, loadVehicles]);

  useEffect(() => {
    vehicleIntervalRef.current = setInterval(loadVehicles, VEHICLE_POLL_MS);
    return () => {
      if (vehicleIntervalRef.current) clearInterval(vehicleIntervalRef.current);
    };
  }, [loadVehicles]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadStops();
    loadVehicles();
  }, [loadStops, loadVehicles]);

  if (!route_id) {
    return (
      <View style={styles.centered}>
        <EmptyState
          icon={MapPinOff}
          title="No route specified"
          subtitle="Open a route from the map or departures list to track it live."
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
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.orange} />
      }
    >
      {/* Header — route signage on Illini navy */}
      <LinearGradient
        colors={theme.gradients.hero}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.header}
      >
        <View style={styles.routeBadge}>
          <Text style={styles.routeBadgeText}>{route_id}</Text>
        </View>
        <View style={styles.headerTextCol}>
          <Text style={styles.headerEyebrow}>MTD route</Text>
          <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
            {route_name || `Route ${route_id}`}
          </Text>
          <Text style={styles.headerSub}>{stops.length} stops · updates every 10s</Text>
        </View>
        {vehicles.length > 0 && <Badge label="LIVE" variant="live" size="sm" />}
      </LinearGradient>

      {/* Live vehicles */}
      {vehicles.length > 0 && (
        <FadeInView style={styles.vehiclesCard}>
          <View style={styles.vehiclesBanner}>
            <LiveDot />
            <Bus size={14} color={theme.colors.brandInk} strokeWidth={2.2} />
            <AnimatedNumber
              value={vehicles.length}
              style={styles.vehiclesCount}
              accessibilityLabel={`${vehicles.length} ${vehicles.length === 1 ? "bus" : "buses"} live on this route`}
            />
            <Text style={styles.vehiclesText}>
              bus{vehicles.length !== 1 ? "es" : ""} live on this route
            </Text>
          </View>

          {/*
            One row per reporting vehicle. Keyed by `vehicle_id` so a bus that
            drops out of the 10s poll does not hand its entrance animation to
            whichever bus takes its index.
          */}
          <Stagger style={styles.vehicleList} itemStyle={styles.vehicleItem}>
            {vehicles.map((v) => (
              <View
                key={v.vehicle_id}
                style={styles.vehicleRow}
                accessible
                accessibilityLabel={`Bus ${v.vehicle_id}, reporting live`}
              >
                <LiveDot small />
                <Text style={styles.vehicleName} numberOfLines={1}>
                  Bus {v.vehicle_id}
                </Text>
                {/* "Live" in words, so the pulsing dot is never the only signal. */}
                <Text style={styles.vehicleLive}>Live</Text>
              </View>
            ))}
          </Stagger>
        </FadeInView>
      )}

      {loading ? (
        <View style={styles.skeletonWrap}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <View key={i} style={styles.skeletonRow}>
              <Skeleton width={14} height={14} radius={7} />
              <Skeleton width={i % 2 === 0 ? 200 : 150} height={14} />
            </View>
          ))}
        </View>
      ) : error ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load this route"
          subtitle={error}
          action={{ label: "Retry", onPress: onRefresh }}
        />
      ) : stops.length === 0 ? (
        /*
          Dev note: an empty (but successful) stop list usually means the
          backend hasn't ingested GTFS yet — run backend/scripts/load_gtfs.py and the
          list appears. That is a server-side fix; the copy below stays
          student-actionable.
        */
        <EmptyState
          icon={MapPinOff}
          title="No stop data for this route"
          subtitle="We don't have the stop list for this route yet. Pull down to refresh, or view it on the Map."
        />
      ) : (
        <StopTimeline stops={stops} vehicles={vehicles} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.surfaceAlt },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: theme.colors.surfaceAlt,
  },
  container: { paddingBottom: 40 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.layout.gutter,
    paddingVertical: 20,
    gap: 14,
  },
  routeBadge: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 52,
    alignItems: "center",
    ...theme.elevation[2],
  },
  routeBadgeText: {
    fontFamily: "DMSans_700Bold",
    fontSize: 20,
    color: theme.colors.navy,
    fontVariant: ["tabular-nums"],
  },
  headerTextCol: { flex: 1 },
  headerEyebrow: {
    ...theme.text.eyebrow,
    color: theme.colors.textOnNavyMuted,
    marginBottom: 2,
  },
  headerTitle: {
    ...theme.text.title2,
    color: theme.colors.textOnNavy,
  },
  headerSub: {
    ...theme.text.caption,
    color: theme.colors.textOnNavyMuted,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },

  vehiclesCard: {
    backgroundColor: theme.colors.surface,
    marginHorizontal: theme.layout.gutter,
    marginTop: theme.layout.cardGap,
    borderRadius: theme.radius.lg,
    paddingVertical: 10,
    paddingHorizontal: 12,
    ...theme.elevation[1],
  },
  vehiclesBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  vehicleList: {
    marginTop: 10,
    paddingTop: 8,
    gap: 2,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderSoft,
  },
  vehicleItem: { justifyContent: "center" },
  vehicleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 28,
  },
  vehicleName: {
    ...theme.text.body,
    fontSize: 14,
    color: theme.colors.text,
    flex: 1,
  },
  vehicleLive: {
    ...theme.text.badge,
    fontSize: 11,
    color: theme.colors.successDeep,
  },
  liveDotWrap: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  liveDotHalo: {
    position: "absolute",
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: theme.colors.orange,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.ctaEnd,
  },
  liveDotWrapSm: {
    width: 12,
    height: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  liveDotHaloSm: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.orange,
  },
  liveDotSm: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.ctaEnd,
  },
  vehiclesCount: {
    ...theme.text.numeric,
    color: theme.colors.text,
  },
  vehiclesText: {
    ...theme.text.body,
    fontSize: 14,
    color: theme.colors.textSecondary,
    flex: 1,
  },

  skeletonWrap: {
    padding: theme.layout.gutter,
    paddingTop: 20,
    gap: 22,
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },

  // Stop timeline
  stopList: {
    paddingTop: LIST_PAD_TOP,
    paddingBottom: LIST_PAD_TOP,
  },
  stopRow: {
    flexDirection: "row",
    height: ROW_H,
  },
  rail: {
    width: theme.layout.gutter + RAIL_W,
    paddingLeft: theme.layout.gutter,
    alignItems: "center",
    justifyContent: "center",
  },
  stopDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.surface,
    borderWidth: 2,
    borderColor: theme.colors.navy,
  },
  stopDotTerminus: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: theme.colors.navy,
    borderColor: theme.colors.navy,
  },
  busDotWrap: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  busDotHalo: {
    position: "absolute",
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.colors.orange,
  },
  busDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: theme.colors.navy,
    borderWidth: 2,
    borderColor: theme.colors.orange,
    alignItems: "center",
    justifyContent: "center",
  },
  stopInfo: {
    flex: 1,
    justifyContent: "center",
    paddingRight: theme.layout.gutter,
  },
  stopInfoDivider: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSoft,
  },
  stopName: {
    ...theme.text.body,
    color: theme.colors.text,
  },
  stopNameTerminus: {
    ...theme.text.subhead,
    color: theme.colors.navy,
  },
  stopMeta: {
    ...theme.text.caption,
    fontSize: 11,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
  busHereChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    marginTop: 3,
    backgroundColor: theme.colors.orangeSoft,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  busHereText: {
    ...theme.text.badge,
    fontSize: 11,
    color: theme.colors.brandInk,
  },
});
