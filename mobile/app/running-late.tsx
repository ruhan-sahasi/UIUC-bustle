// app/running-late.tsx
// Shows catchable buses with live countdowns when user is running late

import * as Location from 'expo-location';
import { useApiBaseUrl } from '@/src/hooks/useApiBaseUrl';
import { fetchNearbyStops, fetchDepartures } from '@/src/api/client';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '@/src/constants/theme';
import { AlertTriangle, Clock, Footprints, MapPin, Navigation, Wind, Zap } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { formatDistance } from '@/src/utils/distance';
import { Button } from '@/src/components/ui/Button';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { Skeleton, Stagger, TickingCountdown } from '@/src/components/ui/motion';
import { STAGGER } from '@/src/constants/motion';

interface CatchableBus {
  stopId: string;
  stopName: string;
  stopLat: number;
  stopLng: number;
  distanceM: number;
  routeId: string;
  headsign: string;
  departsInMins: number;
  departsEpochMs: number;
  walkPaceNeeded: 'easy' | 'brisk' | 'run';
  onTimeForClass: boolean;
  lateByMins: number;
}

/**
 * Pace urgency, never color-only: each chip pairs its AA-deep fill with an
 * icon and a text label.
 */
const PACE_META: Record<'easy' | 'brisk' | 'run', { label: string; color: string; icon: LucideIcon }> = {
  easy: { label: 'Easy walk', color: theme.colors.successDeep, icon: Footprints },
  brisk: { label: 'Walk fast', color: theme.colors.warningDeep, icon: Wind },
  run: { label: 'Run!', color: theme.colors.errorDeep, icon: Zap },
};

export default function RunningLateScreen() {
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const router = useRouter();

  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [catchableBuses, setCatchableBuses] = useState<CatchableBus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCatchableBuses = async (loc: { lat: number; lng: number }) => {
    try {
      const RADIUS_M = 640; // ~0.4 miles
      const MAX_DEPART_MINS = 8;

      const nearbyRes = await fetchNearbyStops(apiBaseUrl, loc.lat, loc.lng, RADIUS_M, { apiKey: apiKey ?? undefined });
      const stops = nearbyRes.stops ?? [];

      const busesNested = await Promise.all(
        stops.map(async (stop) => {
          // Distance from stop lat/lng stored in StopInfo — compute haversine
          const R = 6371000;
          const dLat = ((stop.lat - loc.lat) * Math.PI) / 180;
          const dLng = ((stop.lng - loc.lng) * Math.PI) / 180;
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((loc.lat * Math.PI) / 180) *
              Math.cos((stop.lat * Math.PI) / 180) *
              Math.sin(dLng / 2) *
              Math.sin(dLng / 2);
          const distanceM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

          try {
            const depRes = await fetchDepartures(apiBaseUrl, stop.stop_id, 15, { apiKey: apiKey ?? undefined });
            const deps = depRes.departures ?? [];
            return deps
              .filter((d) => d.expected_mins <= MAX_DEPART_MINS && d.expected_mins >= 0)
              .map((d) => {
                const departsEpochMs = Date.now() + d.expected_mins * 60 * 1000;
                const speedMps = d.expected_mins > 0
                  ? distanceM / (d.expected_mins * 60)
                  : 999;
                const walkPaceNeeded: 'easy' | 'brisk' | 'run' =
                  speedMps < 1.2 ? 'easy' : speedMps <= 2.0 ? 'brisk' : 'run';
                return {
                  stopId: stop.stop_id,
                  stopName: stop.stop_name,
                  stopLat: stop.lat,
                  stopLng: stop.lng,
                  distanceM,
                  routeId: d.route,
                  headsign: d.headsign,
                  departsInMins: d.expected_mins,
                  departsEpochMs,
                  walkPaceNeeded,
                  onTimeForClass: true,
                  lateByMins: 0,
                } as CatchableBus;
              });
          } catch {
            return [] as CatchableBus[];
          }
        })
      );

      const allBuses = busesNested.flat().sort((a, b) => a.departsInMins - b.departsInMins);
      setCatchableBuses(allBuses);
      setLoadError(false);
    } catch {
      // A failed request is NOT "no buses" — keep any list we already have and
      // flag the failure so the UI can say so honestly instead of telling a
      // sprinting student to give up.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  // Get location + initial fetch
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setLoading(false);
          return;
        }
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setLocation(loc);
        await fetchCatchableBuses(loc);

        // Poll every 20 seconds
        pollRef.current = setInterval(async () => {
          await fetchCatchableBuses(loc);
        }, 20_000);
      } catch {
        setLoading(false);
      }
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, apiKey]);

  const onRetry = () => {
    if (!location) return;
    setLoading(true);
    fetchCatchableBuses(location);
  };

  const onNavigateToStop = (bus: CatchableBus) => {
    router.push({
      pathname: '/walk-nav',
      params: {
        dest_lat: String(bus.stopLat),
        dest_lng: String(bus.stopLng),
        dest_name: bus.stopName,
        route_id: bus.routeId,
      },
    });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* Hero header — Illini navy signage */}
      <LinearGradient
        colors={theme.gradients.hero}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.header}
      >
        <Text style={styles.headerEyebrow}>Live departures near you</Text>
        <Text style={styles.headerTitle} accessibilityRole="header">Running late?</Text>
        <Text style={styles.headerSubtitle}>Buses you can still catch, soonest first</Text>
      </LinearGradient>

      {loading && (
        <View style={styles.skeletonWrap}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeletonCard}>
              <View style={styles.skeletonRow}>
                <Skeleton width={44} height={24} radius={theme.radius.sm} />
                <Skeleton width={120} height={16} />
                <View style={{ flex: 1 }} />
                <Skeleton width={72} height={30} />
              </View>
              <Skeleton width={180} height={12} style={{ marginTop: 10 }} />
              <Skeleton height={44} radius={theme.radius.lg} style={{ marginTop: 12 }} />
            </View>
          ))}
          <Text style={styles.loadingText}>Finding nearby buses…</Text>
        </View>
      )}

      {/* Location denied / unavailable */}
      {!loading && !location && (
        <EmptyState
          icon={MapPin}
          title="We need your location"
          subtitle="Allow location access so we can find stops you can still reach in time."
        />
      )}

      {/* Request failed and we have nothing to show — an honest error, not
          "no buses". The 20s poll also recovers on its own. */}
      {!loading && location != null && loadError && catchableBuses.length === 0 && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't check departures"
          subtitle="We couldn't reach the bus service, so we don't know what's catchable. Check your connection and retry."
          action={{ label: 'Retry', onPress: onRetry }}
        />
      )}

      {/* Nothing catchable — only claimed when the request actually succeeded */}
      {!loading && location != null && !loadError && catchableBuses.length === 0 && (
        <EmptyState
          icon={Clock}
          title="No catchable buses right now"
          subtitle="Nothing departs within walking range in the next 8 minutes. Consider walking or calling a ride."
        />
      )}

      {/*
        One entrance vocabulary for the departure board. Replaces the old
        hand-written `delay={i * 60}`: `listCap` bounds the wait, so a dense
        block of catchable buses still finishes arriving in about a third of a
        second instead of scaling with the list.
      */}
      {!loading && catchableBuses.length > 0 && (
        <Stagger step={STAGGER.listStep} cap={STAGGER.listCap}>
          {catchableBuses.map((bus, i) => {
            const pace = PACE_META[bus.walkPaceNeeded];
            const PaceIcon = pace.icon;
            const isNext = i === 0;
            return (
              <View
                // Stable across refreshes. The list re-sorts by departure time on
                // every fetch, so an index in the key makes a bus that changed
                // position unmount, remount and replay its entrance. departsEpochMs
                // is no good either: it is re-anchored to Date.now() each poll.
                key={`${bus.stopId}-${bus.routeId}-${bus.headsign}`}
                style={[styles.busCard, isNext && styles.busCardNext]}
              >
                {/* Top row: route badge + headsign + live countdown */}
                <View
                  style={styles.busCardTopRow}
                  accessible
                  accessibilityLabel={`Bus ${bus.routeId} toward ${bus.headsign}, leaves in about ${bus.departsInMins} minutes from ${bus.stopName}`}
                >
                  <View style={styles.routeBadge}>
                    <Text style={styles.routeBadgeText}>{bus.routeId}</Text>
                  </View>
                  <Text style={styles.headsign} numberOfLines={2}>{bus.headsign}</Text>
                  <View style={styles.countdownCol}>
                    <Text style={styles.countdownLabel}>Leaves in</Text>
                    <TickingCountdown
                      targetMs={bus.departsEpochMs}
                      nowLabel="Now"
                      style={isNext ? styles.countdownNext : styles.countdown}
                    />
                  </View>
                </View>

                {/* Stop name + distance */}
                <View style={styles.stopRow}>
                  <MapPin size={13} color={theme.colors.textMuted} />
                  <Text style={styles.stopName} numberOfLines={1}>
                    {bus.stopName} · {formatDistance(bus.distanceM)} away
                  </Text>
                </View>

                {/* Pace chip: icon + text on an AA-deep fill */}
                <View style={styles.paceRow}>
                  <View
                    style={[styles.paceBadge, { backgroundColor: pace.color }]}
                    accessible
                    accessibilityLabel={`Pace needed: ${pace.label}`}
                  >
                    <PaceIcon size={12} color={theme.colors.surface} strokeWidth={2.4} />
                    <Text style={styles.paceBadgeText}>{pace.label}</Text>
                  </View>
                </View>

                <Button label="Navigate to stop" accessibilityLabel={`Navigate to ${bus.stopName}`} icon={Navigation} onPress={() => onNavigateToStop(bus)} />
              </View>
            );
          })}
        </Stagger>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surfaceAlt,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.spacing.xl,
    paddingBottom: theme.spacing.lg,
  },
  headerEyebrow: {
    ...theme.text.eyebrow,
    color: theme.colors.textOnNavyMuted,
    marginBottom: 6,
  },
  headerTitle: {
    ...theme.text.title1,
    color: theme.colors.textOnNavy,
    marginBottom: 4,
  },
  headerSubtitle: {
    ...theme.text.body,
    fontSize: 14,
    color: theme.colors.textOnNavyMuted,
  },

  // Loading skeletons — departure-board rows shimmer in
  skeletonWrap: {
    paddingTop: theme.layout.cardGap,
  },
  skeletonCard: {
    backgroundColor: theme.colors.surface,
    marginHorizontal: theme.layout.gutter,
    marginBottom: theme.layout.cardGap,
    borderRadius: theme.radius.xl,
    padding: theme.layout.gutter,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.borderSoft,
    ...theme.elevation[1],
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
  },

  // Bus cards — hierarchy by time-to-leave: the soonest card leads
  busCard: {
    backgroundColor: theme.colors.surface,
    marginHorizontal: theme.layout.gutter,
    marginTop: theme.layout.cardGap,
    borderRadius: theme.radius.xl,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.orange,
    padding: theme.layout.gutter,
    ...theme.elevation[1],
  },
  busCardNext: {
    borderLeftWidth: 4,
    ...theme.elevation[2],
  },
  busCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  routeBadge: {
    backgroundColor: theme.colors.navy,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 9,
    paddingVertical: 4,
    minWidth: 40,
    alignItems: 'center',
  },
  routeBadgeText: {
    ...theme.text.badge,
    color: theme.colors.surface,
    fontVariant: ['tabular-nums'],
  },
  headsign: {
    ...theme.text.subhead,
    fontSize: 14,
    color: theme.colors.navy,
    flex: 1,
  },
  countdownCol: {
    alignItems: 'flex-end',
  },
  countdownLabel: {
    ...theme.text.eyebrow,
    fontSize: 10,
    color: theme.colors.textMuted,
    marginBottom: 1,
  },
  countdown: {
    ...theme.text.display,
    fontSize: 24,
    lineHeight: 28,
    color: theme.colors.brandInk,
  },
  countdownNext: {
    ...theme.text.display,
    fontSize: 34,
    lineHeight: 38,
    color: theme.colors.brandInk,
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 10,
  },
  stopName: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    flex: 1,
  },
  paceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.layout.cardGap,
  },
  paceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  paceBadgeText: {
    ...theme.text.badge,
    fontSize: 11,
    color: theme.colors.surface,
  },
});
