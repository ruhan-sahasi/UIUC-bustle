import { createShareTrip, fetchAutocomplete, fetchBuildings, fetchDepartures, fetchPlaceDetails, fetchRecommendation } from "@/src/api/client";
import type { AutocompleteResult } from "@/src/api/client";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { useClassNotificationsEnabled } from "@/src/hooks/useClassNotificationsEnabled";
import { useRecommendationSettings } from "@/src/hooks/useRecommendationSettings";
import { useLeaveBy } from "@/src/hooks/useLeaveBy";
import { useAnalytics } from "@/src/hooks/useAnalytics";
import type { DepartureItem, RecommendationOption, RecommendationStep, ShareTripRequest, StopInfo } from "@/src/api/types";
import { cancelClassReminder, cancelAllClassReminders, scheduleClassReminders } from "@/src/notifications/classReminders";
import { scheduleLeaveNowAlert, cancelLeaveNowAlert, buildLeaveNowBody } from "@/src/notifications/leaveNow";
import { addFavoriteStop, addFavoritePlace, getAfterLastClassPlaceId, getFavoritePlaces, type SavedPlace } from "@/src/storage/favorites";
import { getPinnedRoutes, addPinnedRoute, removePinnedRoute, type PinnedRoute } from "@/src/storage/pinnedRoutes";
import { getLastKnownHomeData, setLastKnownHomeData } from "@/src/storage/lastKnownHome";
import { useNetworkStatus } from "@/src/utils/networkStatus";
import { dataStatus } from "@/src/utils/freshness";
import { setClassSummary, setClassRouteData } from "@/src/storage/classSummaryCache";
import type { ClassRouteData } from "@/src/storage/classSummaryCache";
import { buildRouteSummary, formatOptionLabel } from "@/src/utils/routeFormatting";
import { markClassAsWalkedToday } from "@/src/storage/walkedClassToday";
import { addRecentSearch, clearRecentSearches, getRecentSearches, type RecentSearch } from "@/src/storage/recentSearches";
import { Badge } from "@/src/components/ui/Badge";
import { DepartureRow } from "@/src/components/ui/DepartureRow";
import { arriveByIsoToday } from "@/src/utils/arriveBy";
import { formatDistance, haversineMeters } from "@/src/utils/distance";
import { getNextClassToday } from "@/src/utils/nextClass";
import * as Location from "expo-location";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useClasses } from "@/src/queries/schedule";
import { useNearbyStops } from "@/src/queries/departures";
import { useRecommendation } from "@/src/queries/recommendation";
import { useAutocomplete } from "@/src/queries/places";
import { useCrowding } from "@/src/queries/crowding";
import { CrowdingBadge } from "@/src/components/ui/CrowdingBadge";
import { CrowdingBanner } from "@/src/components/CrowdingBanner";
function newSessionToken(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

interface OptionCardWithCrowdingProps {
  option: RecommendationOption;
  children: React.ReactNode;
}
function OptionCardWithCrowding({ option, children }: OptionCardWithCrowdingProps) {
  const rideStep = option.steps?.find((s) => s.type === "RIDE");
  const { data: crowding } = useCrowding(rideStep?.vehicle_id ?? null, rideStep?.route_id);
  if (!crowding || option.type !== "BUS") return <>{children}</>;
  return (
    <View>
      {children}
      <View style={{ paddingHorizontal: 20, paddingBottom: 4, marginTop: -4 }}>
        <CrowdingBadge info={crowding} size="sm" />
      </View>
    </View>
  );
}
import {
  ActivityIndicator,
  Alert,
  LayoutChangeEvent,
  Linking,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme } from "@/src/constants/theme";
import { STAGGER } from "@/src/constants/motion";
import {
  AnimatedNumber,
  Beacon,
  FadeInView,
  fireHaptic,
  Press,
  PressableScale,
  PulseView,
  Skeleton,
  Stagger,
  TickingCountdown,
} from "@/src/components/ui/motion";
import { CollapsingHeader } from "@/src/components/ui/CollapsingHeader";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { EmptyState } from "@/src/components/ui/EmptyState";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowRight, Clock, Footprints, MapPin, Search, Star, X } from "lucide-react-native";

const TOP_STOPS = 3;
/** Cap each stop card's departure list — the API can return an hour of rows. */
const MAX_DEPARTURES_PER_STOP = 6;
const UIUC_FALLBACK = { lat: 40.102, lng: -88.2272 };

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** Gently breathing beckon arrow — PulseView obeys reduce-motion internally. */
function NextUpArrow() {
  return (
    <PulseView minOpacity={0.55} duration={1200}>
      <ArrowRight size={16} color={theme.colors.brandInk} />
    </PulseView>
  );
}

/**
 * The navy hero's height below the top safe-area inset, in px.
 *
 * `CollapsingHeader` needs a FIXED box: it slides the header with `translateY`
 * rather than animating its height, so the height cannot depend on which hero
 * variant is showing. Sized for the tallest one (greeting + date + next-class
 * chip + full marquee); the hero content is bottom-anchored inside the box, so
 * the marquee's bottom edge — and therefore its gap to the search card that
 * starts below the box — lands in exactly the same place in every variant, and
 * the shorter variants spend the slack as empty navy under the status bar
 * where nothing lives.
 */
const HERO_BODY_HEIGHT = 300;

/** The collapsed one-line strip's height below the top safe-area inset, px. */
const STRIP_BODY_HEIGHT = 42;

/**
 * Px of collapse over which the hero cross-fades into the strip. Wider than
 * the primitive's default because the strip duplicates the hero's marquee: it
 * only earns the top of the screen once that marquee has scrolled away.
 */
const STRIP_FADE_WINDOW = 70;

/**
 * Hero content that recedes as the page scrolls.
 *
 * TRANSFORM + OPACITY ONLY. Animating the hero's height would re-lay-out this
 * screen's entire content tree on every frame, so the "collapse" is a fade and
 * a scale into the sticky strip that replaces it — the layout box never moves.
 * `from`/`to` slice the shared 0..1 progress so the greeting can leave before
 * the marquee does.
 */
function HeroFade({
  progress,
  from = 0,
  to = 1,
  dy = 10,
  scaleTo = 0.94,
  children,
}: {
  progress: SharedValue<number>;
  from?: number;
  to?: number;
  dy?: number;
  scaleTo?: number;
  children: React.ReactNode;
}) {
  const style = useAnimatedStyle(() => {
    const span = to - from > 0 ? to - from : 1;
    const t = Math.min(Math.max((progress.value - from) / span, 0), 1);
    return {
      opacity: 1 - t * 0.9,
      transform: [{ translateY: t * dy }, { scale: 1 - (1 - scaleTo) * t }],
    };
  }, [from, to, dy, scaleTo]);
  return <Animated.View style={style}>{children}</Animated.View>;
}

/**
 * Fires HAPTIC.warn exactly once on the false -> true edge of `departing`.
 *
 * An edge, tracked in a ref — not a per-render call. Lives in its own
 * component so the screen's hook list stays exactly as the reliability pass
 * left it.
 */
function DepartingEdgeHaptic({ departing }: { departing: boolean }) {
  // Seeded with the FIRST value, not `false`. A card that mounts already
  // departing is not an edge: firing there would buzz on every return to this
  // tab, and up to three times at once, because the search / after-class /
  // recommendation lists each render their own index-0 card.
  const wasDeparting = useRef(departing);
  useEffect(() => {
    if (departing && !wasDeparting.current) fireHaptic("warn");
    wasDeparting.current = departing;
  }, [departing]);
  return null;
}

type StopWithDistance = StopInfo & { distance_m: number };

function optionCardTitle(index: number, opt: RecommendationOption): string {
  if (opt.type === "WALK") return "Walk";
  if (index === 0) return "Best option";
  return "Alternative";
}

/** Sum duration_minutes for steps that are walking (WALK_TO_STOP, WALK_TO_DEST). */
function sumWalkingMinutes(steps: RecommendationStep[]): number {
  return steps
    .filter((s) => s.type === "WALK_TO_STOP" || s.type === "WALK_TO_DEST")
    .reduce((acc, s) => acc + (s.duration_minutes ?? 0), 0);
}

/** Build a compact step-flow string like "Walk 4m → Bus 220 → Walk 0.4m" */
function buildStepFlow(steps: RecommendationStep[]): string {
  const parts: string[] = [];
  for (const s of steps) {
    if (s.type === "WAIT") continue;
    if (s.type === "WALK_TO_STOP") {
      const mins = s.duration_minutes != null && s.duration_minutes > 0 ? `${Math.round(s.duration_minutes)}m` : "";
      parts.push(mins ? `Walk ${mins}` : "Walk to stop");
    } else if (s.type === "RIDE") {
      parts.push(`Bus ${s.route ?? ""}`.trim());
    } else if (s.type === "WALK_TO_DEST") {
      const mins = s.duration_minutes != null && s.duration_minutes > 0 ? `${Math.round(s.duration_minutes)}m` : "";
      // Skip the final walk-to-dest if it has no meaningful duration (e.g. alighting stop IS the destination)
      if (mins) parts.push(`Walk ${mins}`);
    }
  }
  return parts.join("  →  ");
}

/** Return a short label: "WALK", "BUS 220", "BUS 22 ALT" */
function getRouteLabel(opt: RecommendationOption, index: number): string {
  if (opt.type === "WALK") return "WALK";
  const rideStep = opt.steps.find((s) => s.type === "RIDE");
  const routeNum = rideStep?.route ?? "";
  const base = routeNum ? `BUS ${routeNum}` : "BUS";
  if (index === 0) return base;
  // For alternatives, show headsign abbreviation if available to differentiate
  const headsign = rideStep?.headsign ?? "";
  const suffix = headsign ? headsign.split(" ")[0].toUpperCase() : "ALT";
  return `${base} · ${suffix}`;
}

export default function HomeScreen() {
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const { enabled: classNotificationsEnabled } = useClassNotificationsEnabled();
  const { walkingModeId, walkingSpeedMps, bufferMinutes, rainMode } = useRecommendationSettings();
  const leaveBy = useLeaveBy();
  const { capture } = useAnalytics();
  const router = useRouter();
  const params = useLocalSearchParams<{ highlight?: string; focus?: string }>();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<"loading" | "error" | "denied" | "ready">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(UIUC_FALLBACK);
  const [afterLastClassPlace, setAfterLastClassPlace] = useState<SavedPlace | null>(null);
  const [afterLastClassRecs, setAfterLastClassRecs] = useState<RecommendationOption[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [highlightWalk, setHighlightWalk] = useState(false);
  const { online } = useNetworkStatus();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<RecommendationOption[]>([]);
  const [searchDestinationName, setSearchDestinationName] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [lastSearchGeo, setLastSearchGeo] = useState<{ lat: number; lng: number; displayName: string } | null>(null);
  const [useUiucArea, setUseUiucArea] = useState(false);
  // Feature: Save from suggestions + post-search save button
  const [savedPlaceNames, setSavedPlaceNames] = useState<Set<string>>(new Set());
  const [searchDestSaved, setSearchDestSaved] = useState(false);
  // Feature: Get me home quick button
  const [homePlace, setHomePlace] = useState<SavedPlace | null>(null);
  // Feature: Pinned quick routes
  const [pinnedRoutes, setPinnedRoutes] = useState<PinnedRoute[]>([]);
  const [searchDestPinned, setSearchDestPinned] = useState(false);
  const [leaveNowBanner, setLeaveNowBanner] = useState<{ option: RecommendationOption; classTitle: string } | null>(null);
  const [routeSort, setRouteSort] = useState<'earliest' | 'fastest' | 'least-walk'>('earliest');
  const [shareToken, setShareToken] = useState<string | null>(null);
  // Typed to the animated surface below — `scrollTo` is unchanged, so every
  // existing effect and handler that drives this ref is untouched.
  const scrollRef = useRef<React.ComponentRef<typeof Animated.ScrollView>>(null);
  const recommendationsY = useRef(0);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep latest location ref for callbacks
  const locationRef = useRef<{ lat: number; lng: number } | null>(null);
  // Google Places session token — reset after each selection for billing grouping
  const sessionTokenRef = useRef<string>(newSessionToken());
  // Notification dedupe: only reschedule if classes changed or >10 min elapsed
  const lastNotifScheduleRef = useRef<{ key: string; at: number } | null>(null);

  // Cached home data for placeholders during cold start
  const [cachedHomeData, setCachedHomeData] = useState<import("@/src/storage/lastKnownHome").LastKnownHomeData | null>(null);
  useEffect(() => {
    getLastKnownHomeData().then(data => setCachedHomeData(data));
  }, []);

  // ── TanStack Query hooks ──────────────────────────────────────────────

  // Classes — shared TQ cache (same key as useLeaveBy — zero duplicate requests)
  const { data: classesData } = useClasses();
  // Stable identity: `?? []` would mint a fresh array every render, re-running
  // every effect that depends on scheduleClasses
  const scheduleClasses = useMemo(() => classesData?.classes ?? [], [classesData]);

  const nextUp = getNextClassToday(scheduleClasses);

  // Nearby stops — depends on location
  const placeholderStops = useMemo(
    () => (cachedHomeData ? { stops: cachedHomeData.stops } : undefined),
    [cachedHomeData]
  );
  const { data: nearbyStopsData, isError: nearbyStopsError } = useNearbyStops(
    location?.lat ?? 0,
    location?.lng ?? 0,
    {
      enabled: !!location && location.lat !== 0,
      placeholderData: placeholderStops,
    }
  );
  // The backend sorts by distance but never returns it, so measure it here.
  const stops: StopWithDistance[] = useMemo(
    () =>
      (nearbyStopsData?.stops ?? [])
        .map((s) => ({
          ...s,
          distance_m: Math.round(haversineMeters(location?.lat ?? 0, location?.lng ?? 0, s.lat, s.lng)),
        }))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, TOP_STOPS),
    [nearbyStopsData, location]
  );

  // Departures — one query per stop, all in parallel. `combine` collapses the
  // per-query results into a value with a stable identity (replaceEqualDeep),
  // so downstream memos and effects only re-run when the data actually changes.
  const departures = useQueries({
    queries: stops.map((stop) => ({
      // Same key shape as useDepartures in src/queries/departures.ts — one
      // cache entry per (stop, server), not a second parallel entry.
      queryKey: ["departures", stop.stop_id, apiBaseUrl],
      queryFn: () => fetchDepartures(apiBaseUrl, stop.stop_id, 60, { apiKey }),
      staleTime: 30_000,
      refetchInterval: 30_000,
      enabled: !!apiBaseUrl && !!stop.stop_id,
    })),
    combine: (results) => {
      const byStop: Record<string, DepartureItem[]> = {};
      const updatedAtByStop: Record<string, number> = {};
      results.forEach((q, i) => {
        const stop = stops[i];
        if (!stop) return;
        byStop[stop.stop_id] = q.data?.departures ?? [];
        updatedAtByStop[stop.stop_id] = q.dataUpdatedAt;
      });
      return {
        byStop,
        updatedAtByStop,
        anyPending: results.some((q) => q.isPending),
        anyError: results.some((q) => q.isError),
        hasData: results.some((q) => q.data !== undefined),
      };
    },
  });
  const departuresByStop = departures.byStop;

  // Recommendation params
  const recParams = useMemo(() => {
    const nextClass = getNextClassToday(scheduleClasses);
    if (!nextClass) return null;
    const hasCustomDest =
      nextClass.destination_lat != null && nextClass.destination_lng != null;
    return {
      lat: location?.lat ?? UIUC_FALLBACK.lat,
      lng: location?.lng ?? UIUC_FALLBACK.lng,
      ...(hasCustomDest
        ? {
            destination_lat: nextClass.destination_lat!,
            destination_lng: nextClass.destination_lng!,
            destination_name: nextClass.destination_name ?? undefined,
          }
        : { destination_building_id: nextClass.building_id }),
      arrive_by_iso: arriveByIsoToday(nextClass.start_time_local),
      walking_speed_mps: walkingSpeedMps,
      buffer_minutes: bufferMinutes,
      max_options: 4,
      prefer_bus: rainMode,
    } as import("@/src/api/types").RecommendationRequest;
  }, [scheduleClasses, location, walkingSpeedMps, bufferMinutes, rainMode]);

  const { data: recData, isPending: recPending } = useRecommendation(recParams);
  // Stable identity: a bare `?? []` would mint a fresh array every render and
  // re-fire every effect (incl. the AsyncStorage write) that depends on it
  const recommendations = useMemo(() => recData?.options ?? [], [recData]);

  // Autocomplete — replaces the debounced fetchAutocomplete useEffect
  const [suppressAutocomplete, setSuppressAutocomplete] = useState(false);
  const { data: autocompleteData } = useAutocomplete(searchQuery.trim());
  const autocompleteSuggestions = suppressAutocomplete ? [] : (autocompleteData?.results ?? []);

  // Load recent searches, saved places, and home place on mount
  useEffect(() => {
    getRecentSearches().then(setRecentSearches);
    (async () => {
      const [places, placeId, pinned] = await Promise.all([
        getFavoritePlaces(),
        getAfterLastClassPlaceId(),
        getPinnedRoutes(),
      ]);
      setSavedPlaceNames(new Set(places.map((p) => p.name)));
      if (placeId) setHomePlace(places.find((p) => p.id === placeId) ?? null);
      setPinnedRoutes(pinned);
    })();
  }, []);

  // ── Location detection ─────────────────────────────────────────────
  // Extracted from the mount effect so the error state's Retry can actually
  // re-run GPS detection — onRefresh() only refetches queries and could never
  // clear status === "error".
  const detectLocation = useCallback(async () => {
    setStatus("loading");
    setErrorMessage(null);
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== "granted") {
        setStatus("denied");
        return;
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      let { latitude, longitude } = loc.coords;
      const distToUiuc = haversineMeters(latitude, longitude, UIUC_FALLBACK.lat, UIUC_FALLBACK.lng);
      if (distToUiuc > 100_000) {
        latitude = UIUC_FALLBACK.lat;
        longitude = UIUC_FALLBACK.lng;
      }
      setLocation({ lat: latitude, lng: longitude });
      locationRef.current = { lat: latitude, lng: longitude };
      setStatus("ready");
    } catch (e) {
      const isAbort = e instanceof Error && e.name === "AbortError";
      if (!isAbort) {
        setStatus("error");
        setErrorMessage(e instanceof Error ? e.message : "Something went wrong");
      }
    }
  }, []);

  useEffect(() => {
    detectLocation();
  }, [detectLocation]);

  // ── Class notification scheduling ─────────────────────────────────
  useEffect(() => {
    if (!classNotificationsEnabled || scheduleClasses.length === 0 || !apiBaseUrl) return;
    const classKey = scheduleClasses.map((c) => c.class_id).sort().join(",");
    if (
      lastNotifScheduleRef.current &&
      lastNotifScheduleRef.current.key === classKey &&
      Date.now() - lastNotifScheduleRef.current.at < 10 * 60 * 1000
    ) return;
    lastNotifScheduleRef.current = { key: classKey, at: Date.now() };
    (async () => {
      try {
        await cancelAllClassReminders();
        // Deliberately NOT cancelAllLeaveNowAlerts() here: scheduleClassReminders
        // never writes leave-now identifiers, so a blanket cancel would leave the
        // live departure alert dead until the next recommendation poll (or forever
        // if the app backgrounds first). scheduleLeaveNowAlert cancels its own
        // identifier before rewriting, and per-class cancels cover delete/mute.
        const buildingsRes = await fetchBuildings(apiBaseUrl, { apiKey: apiKey ?? undefined }).catch(() => ({ buildings: [] }));
        const buildingMap: Record<string, string> = {};
        for (const b of buildingsRes.buildings ?? []) buildingMap[b.building_id] = b.name;
        await scheduleClassReminders(scheduleClasses, buildingMap, walkingSpeedMps, bufferMinutes);
      } catch (_) {
        await scheduleClassReminders(scheduleClasses, {}, walkingSpeedMps, bufferMinutes);
      }
    })();
  }, [scheduleClasses, classNotificationsEnabled, apiBaseUrl, apiKey, walkingSpeedMps, bufferMinutes]);

  // ── Cache home data for offline cold start ────────────────────────
  useEffect(() => {
    if (!location || stops.length === 0) return;
    setLastKnownHomeData({
      stops,
      departuresByStop,
      scheduleClasses,
      recommendations,
      location,
    }).catch(() => {});
  }, [stops, departuresByStop, scheduleClasses, recommendations, location]);

  // ── Recommendation analytics + classSummaryCache ──────────────────
  useEffect(() => {
    if (recommendations.length === 0) return;
    const nextClass = getNextClassToday(scheduleClasses);
    capture("route_viewed", {
      route_count: recommendations.length,
      next_class_minutes: nextClass
        ? Math.round((new Date(arriveByIsoToday(nextClass.start_time_local)).getTime() - Date.now()) / 60000)
        : undefined,
    });
    if (nextClass) {
      const summary = buildRouteSummary(recommendations);
      if (summary) setClassSummary(nextClass.class_id, summary).catch(() => {});
      const routeData: ClassRouteData = {
        summary,
        bestDepartInMinutes: Math.min(...recommendations.map((o) => o.depart_in_minutes)),
        etaMinutes: recommendations[0]?.eta_minutes ?? 0,
        options: recommendations.map((o) => ({ label: formatOptionLabel(o), departInMinutes: o.depart_in_minutes })),
      };
      setClassRouteData(nextClass.class_id, routeData).catch(() => {});
    }
  }, [recommendations, scheduleClasses]);

  // ── Leave Now banner ──────────────────────────────────────────────
  useEffect(() => {
    if (!classNotificationsEnabled || recommendations.length === 0) return;
    const nextClass = getNextClassToday(scheduleClasses);
    if (!nextClass) return;
    const best = recommendations[0];
    scheduleLeaveNowAlert(nextClass.class_id, nextClass.title, best).catch(() => {});
    setLeaveNowBanner(best.depart_in_minutes <= 2 ? { option: best, classTitle: nextClass.title } : null);
  }, [recommendations, classNotificationsEnabled, scheduleClasses]);

  // ── Offline / stale-data banner ───────────────────────────────────
  // Honest state: when offline or the live fetch errors, show the age of the
  // cached snapshot we're falling back to (or an empty state if there's none).
  // Derived straight from the combined query state — no effect or state needed.
  const bannerText = useMemo(() => {
    return dataStatus({
      online,
      isError: departures.anyError,
      hasLiveData: online && !departures.anyError,
      cacheAgeMs: cachedHomeData ? Date.now() - cachedHomeData.savedAt : null,
    }).banner;
  }, [departures.anyError, online, cachedHomeData]);

  // ── After-last-class place recommendations ────────────────────────
  useEffect(() => {
    const nextClass = getNextClassToday(scheduleClasses);
    if (nextClass || !location || !apiBaseUrl) return;
    (async () => {
      const placeId = await getAfterLastClassPlaceId();
      const places = await getFavoritePlaces();
      const place = places.find((p) => p.id === placeId) ?? null;
      // Functional updates that bail on equal values — this effect can re-run
      // on identity-only dep changes, and unconditional sets would loop
      setAfterLastClassPlace((prev) => (prev?.id === place?.id ? prev : place));
      if (!place) {
        setAfterLastClassRecs((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      try {
        const arriveBy = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
        const rec = await fetchRecommendation(apiBaseUrl, {
          lat: location.lat,
          lng: location.lng,
          destination_lat: place.lat,
          destination_lng: place.lng,
          destination_name: place.name,
          arrive_by_iso: arriveBy,
          max_options: 3,
          walking_speed_mps: walkingSpeedMps,
          buffer_minutes: bufferMinutes,
        }, { apiKey: apiKey ?? undefined });
        setAfterLastClassRecs(rec.options ?? []);
      } catch {
        setAfterLastClassRecs((prev) => (prev.length === 0 ? prev : []));
      }
    })();
  }, [scheduleClasses, location, apiBaseUrl]);

  useEffect(() => {
    if (params.highlight === "walk") setHighlightWalk(true);
  }, [params.highlight]);

  useEffect(() => {
    if (params.focus !== "recommendations") return;
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({
        y: recommendationsY.current,
        animated: true,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [params.focus]);

  // ── Pull-to-refresh via TQ invalidation ────────────────────────────
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      queryClient.refetchQueries({ queryKey: ["classes"] }),
      queryClient.refetchQueries({ queryKey: ["nearby-stops"] }),
      queryClient.refetchQueries({ queryKey: ["departures"] }),
      queryClient.refetchQueries({ queryKey: ["recommendation"] }),
    ]);
    setRefreshing(false);
  }, [queryClient]);

  const onStartWalk = useCallback((opt: RecommendationOption, destNameOverride?: string) => {
    fireHaptic("commit");
    const step = opt.steps.find((s) => s.type === "WALK_TO_DEST");
    if (step?.building_lat != null && step?.building_lng != null) {
      router.push({
        pathname: "/walk-nav",
        params: {
          dest_lat: String(step.building_lat),
          dest_lng: String(step.building_lng),
          dest_name: destNameOverride ?? nextUp?.title ?? "Destination",
          walking_mode_id: walkingModeId,
          building_id: nextUp?.building_id ?? "",
          arrive_by_class_time: nextUp?.start_time_local ?? "",
        },
      });
    }
  }, [router, nextUp, walkingModeId]);

  const onStartBus = useCallback(
    (opt: RecommendationOption) => {
      fireHaptic("commit");
      // Walk to the bus stop using the internal walk-nav map (no app switching)
      const step = opt.steps.find((s) => s.type === "WALK_TO_STOP");
      const rideStep = opt.steps.find((s) => s.type === "RIDE");
      const destStep = opt.steps.find((s) => s.type === "WALK_TO_DEST");
      const routeId = rideStep?.route ?? "";
      const alightingStopId = rideStep?.alighting_stop_id ?? "";
      const alightingLat = rideStep?.alighting_stop_lat ?? null;
      const alightingLng = rideStep?.alighting_stop_lng ?? null;
      const busDepEpochMs = Date.now() + opt.depart_in_minutes * 60000;
      if (step?.stop_lat != null && step?.stop_lng != null) {
        router.push({
          pathname: "/walk-nav",
          params: {
            dest_lat: String(step.stop_lat),
            dest_lng: String(step.stop_lng),
            dest_name: step.stop_name ?? "Bus Stop",
            walking_mode_id: walkingModeId,
            route_id: routeId,
            stop_id: step.stop_id ?? "",
            alighting_stop_id: alightingStopId ?? "",
            alighting_lat: alightingLat != null ? String(alightingLat) : "",
            alighting_lng: alightingLng != null ? String(alightingLng) : "",
            bus_dep_epoch_ms: String(busDepEpochMs),
            arrive_by_class_time: nextUp?.start_time_local ?? "",
            final_lat: destStep?.building_lat != null ? String(destStep.building_lat) : "",
            final_lng: destStep?.building_lng != null ? String(destStep.building_lng) : "",
            final_name: nextUp?.title ?? "",
          },
        });
      }
    },
    [router, walkingModeId, nextUp]
  );

  const onWalkingToClass = useCallback(async () => {
    if (!nextUp) return;
    await markClassAsWalkedToday(nextUp.class_id);
    await cancelClassReminder(nextUp.class_id);
    await cancelLeaveNowAlert(nextUp.class_id);
    setLeaveNowBanner(null);
  }, [nextUp]);

  /** Shared recommendation fetch used by both search paths. */
  const _fetchRoutesTo = useCallback(async (destLat: number, destLng: number, destName: string, queryLabel: string) => {
    if (!location) return;
    setSearchDestSaved(false);
    setSearchDestPinned(false);
    const arriveBy = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const rec = await fetchRecommendation(apiBaseUrl, {
      lat: location.lat,
      lng: location.lng,
      destination_lat: destLat,
      destination_lng: destLng,
      destination_name: destName,
      arrive_by_iso: arriveBy,
      max_options: 3,
      walking_speed_mps: walkingSpeedMps,
      buffer_minutes: bufferMinutes,
    }, { apiKey: apiKey ?? undefined });
    setSearchResults(rec.options ?? []);
    setSearchDestinationName(destName);
    setLastSearchGeo({ lat: destLat, lng: destLng, displayName: destName });
    await addRecentSearch({ query: queryLabel, displayName: destName, lat: destLat, lng: destLng });
    setRecentSearches(await getRecentSearches());
  }, [apiBaseUrl, apiKey, location, walkingSpeedMps, bufferMinutes]);

  const onGetMeHome = useCallback(async () => {
    if (!homePlace || !location) return;
    setSearchQuery(homePlace.name);
    setSearchLoading(true);
    setSearchResults([]);
    setSearchDestinationName(null);
    setSearchDestSaved(false);
    setSearchError(null);
    setSuppressAutocomplete(true);
    try {
      await _fetchRoutesTo(homePlace.lat, homePlace.lng, homePlace.name, homePlace.name);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setSearchLoading(false);
    }
  }, [homePlace, location, _fetchRoutesTo]);

  /** Tap any autocomplete suggestion (building, place, or google_place) — immediately loads routes. */
  const onSelectSuggestion = useCallback(async (item: AutocompleteResult) => {
    const displayName = item.display_name?.split(",")[0]?.trim() || item.name;
    setSearchQuery(displayName);
    setSuppressAutocomplete(true);
    setSearchError(null);
    setSearchResults([]);
    setSearchDestinationName(null);
    setSearchLoading(true);
    // Reset session token after selection (new session for next search)
    sessionTokenRef.current = newSessionToken();
    try {
      let lat = item.lat;
      let lng = item.lng;
      let resolvedName = item.display_name || item.name;
      if (lat !== 0 && lng !== 0) {
        // Coords already embedded — use directly, no extra network call needed
      } else if (item.type === "google_place" && item.place_id) {
        // Fallback: resolve coords via /places/details (lat=0 means backend didn't embed them)
        const details = await fetchPlaceDetails(apiBaseUrl, item.place_id, { apiKey: apiKey ?? undefined });
        lat = details.lat;
        lng = details.lng;
        if (details.display_name) resolvedName = details.display_name;
      }
      await _fetchRoutesTo(lat, lng, resolvedName, displayName);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Search failed.");
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [_fetchRoutesTo, apiBaseUrl, apiKey]);

  const onSearchDestination = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q || !location) return;
    // Fire-and-forget: awaiting the haptic here delayed the loading state.
    fireHaptic("commit");
    setSearchError(null);
    setSearchResults([]);
    setSearchDestinationName(null);
    setSuppressAutocomplete(true);
    setSearchLoading(true);
    try {
      // Use the autocomplete endpoint to resolve: tries buildings first, then Nominatim
      const acRes = await fetchAutocomplete(apiBaseUrl, q, { apiKey: apiKey ?? undefined });
      if (acRes.results.length > 0) {
        const best = acRes.results[0];
        const destName = best.display_name || best.name;
        await _fetchRoutesTo(best.lat, best.lng, destName, q);
      } else {
        setSearchError("No results found. Try a different name or address.");
        setSearchResults([]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Search failed.";
      setSearchError(msg.includes("Geocoding") || msg.includes("unavailable")
        ? "Geocoding service unavailable. Is the backend running?"
        : msg);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [apiBaseUrl, apiKey, location, searchQuery, _fetchRoutesTo]);

  /** Build a shareable ETA message for this route option. */
  const buildShareMessage = (opt: RecommendationOption, destName: string): string => {
    const dest = destName.split(",")[0];
    if (opt.type === "WALK") return `Walking to ${dest} — arriving in ~${opt.eta_minutes} min`;
    const rideStep = opt.steps.find((s) => s.type === "RIDE");
    const route = rideStep?.route ? `Bus ${rideStep.route}` : "bus";
    const depart = Math.round(opt.depart_in_minutes);
    const departStr = depart <= 1 ? "leaving now" : `leaving in ${depart} min`;
    return `Taking ${route} to ${dest} — ${departStr}, arriving in ~${opt.eta_minutes} min`;
  };

  // NOTE: must stay above the early returns below — hooks may not run
  // conditionally, and this is the component's last hook
  const handleShare = useCallback(async (opt: RecommendationOption, destName: string) => {
    const rideStep = opt.steps.find((s) => s.type === "RIDE");
    const etaEpoch = Math.floor(Date.now() / 1000) + opt.eta_minutes * 60;
    const body: ShareTripRequest = {
      destination: destName.split(",")[0],
      route_id: rideStep?.route ?? null,
      route_name: rideStep?.headsign ?? null,
      stop_name: rideStep?.stop_name ?? null,
      phase: "walking",
      eta_epoch: etaEpoch,
    };
    const message = buildShareMessage(opt, destName);
    try {
      const result = await createShareTrip(apiBaseUrl, body, { apiKey: apiKey ?? undefined });
      setShareToken(result.token);
      await Share.share({ message: `${message}\n${result.url}`, url: result.url });
    } catch {
      // Fallback to message-only share
      await Share.share({ message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buildShareMessage is pure & stateless
  }, [apiBaseUrl, apiKey]);

  if (status === "loading" && !refreshing) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surfaceAlt }}>
        <LinearGradient
          colors={[theme.gradients.hero[0], theme.gradients.hero[1], theme.gradients.hero[2]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.heroBlock, { paddingTop: insets.top + 16 }]}
        >
          <Text style={styles.heroGreeting}>{getGreeting()}</Text>
          <Text style={styles.heroDate}>Getting location and nearby stops…</Text>
        </LinearGradient>
        <View style={{ paddingHorizontal: 16, gap: 12, marginTop: -theme.radius.xxl }}>
          <Skeleton width="100%" height={150} radius={theme.radius.xl} />
          <Skeleton width="100%" height={96} radius={theme.radius.xl} />
          <Skeleton width="100%" height={96} radius={theme.radius.xl} />
          <Skeleton width="100%" height={96} radius={theme.radius.xl} />
        </View>
      </View>
    );
  }

  if (status === "denied") {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Location permission denied</Text>
        <Text style={styles.hint}>Enable location in Settings to see nearby stops.</Text>
        <Pressable
          style={styles.retryBtn}
          onPress={() => Linking.openSettings()}
          accessibilityLabel="Open location settings"
          accessibilityRole="button"
        >
          <Text style={styles.retryBtnText}>Open Location Settings</Text>
        </Pressable>
      </View>
    );
  }

  if (status === "error") {
    // This state is only ever reached from a location exception — the query
    // layer has its own error handling — so the copy talks about GPS, and
    // Retry re-runs location detection (a query refetch could never fix it).
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText} accessibilityRole="header">Couldn't get your location</Text>
        {errorMessage ? <Text style={styles.hint}>{errorMessage}</Text> : null}
        <Text style={styles.hint}>Make sure Location Services are on, then try again.</Text>
        <Pressable
          accessibilityLabel="Retry location detection"
          accessibilityRole="button"
          onPress={() => { detectLocation(); }}
          style={styles.retryBtn}
        >
          <Text style={styles.retryBtnText}>Retry</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue with the UIUC campus area instead of your location"
          style={[styles.retryBtn, styles.retryBtnSecondary]}
          onPress={() => {
            // Escape hatch: proceed with the campus-center fallback. `location`
            // already defaults to UIUC_FALLBACK, so flipping status is enough.
            setUseUiucArea(true);
            setLocation(UIUC_FALLBACK);
            locationRef.current = UIUC_FALLBACK;
            setStatus("ready");
          }}
        >
          <Text style={styles.retryBtnSecondaryText}>Use UIUC area (test MTD)</Text>
        </Pressable>
      </View>
    );
  }

  /** Determine on-time status of an option vs the next class start time. */
  const optionStatus = (opt: RecommendationOption, nextClassStartTime?: string): 'on-time' | 'tight' | 'late' | 'walk-only' => {
    if (opt.type === 'WALK') return 'walk-only';
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    if (!nextClassStartTime) return 'on-time';
    const [h, m] = nextClassStartTime.split(':').map(Number);
    const classMins = (h ?? 0) * 60 + (m ?? 0);
    // eta_minutes is already total door-to-door time (incl. the wait), so
    // arrival is now + eta — adding depart_in would double-count the wait
    const arrivalMins = nowMins + opt.eta_minutes;
    const margin = classMins - arrivalMins;
    if (margin >= 5) return 'on-time';
    if (margin >= 0) return 'tight';
    return 'late';
  };

  /** Sort a list of route options by the current routeSort state. */
  const sortedOptions = (opts: RecommendationOption[]): RecommendationOption[] => {
    const copy = [...opts];
    if (routeSort === 'earliest') {
      copy.sort((a, b) => a.depart_in_minutes - b.depart_in_minutes);
    } else if (routeSort === 'fastest') {
      copy.sort((a, b) => a.eta_minutes - b.eta_minutes);
    } else if (routeSort === 'least-walk') {
      const walkSum = (o: RecommendationOption) =>
        o.steps
          .filter((s) => s.type === 'WALK_TO_STOP' || s.type === 'WALK_TO_DEST')
          .reduce((acc, s) => acc + (s.duration_minutes ?? 0), 0);
      copy.sort((a, b) => walkSum(a) - walkSum(b));
    }
    return copy;
  };

  // ── Hero "next departure" marquee ─────────────────────────────────
  // The single most useful bus right now, derived purely from data the
  // component already fetched (nearby stops + their departures). No hooks,
  // no extra requests — just a render-time scan of at most 3 stops.
  let nextDeparture: { stop: StopWithDistance; dep: DepartureItem } | null = null;
  for (const stop of stops) {
    for (const dep of departuresByStop[stop.stop_id] ?? []) {
      if (dep.expected_mins < 0) continue;
      if (!nextDeparture || dep.expected_mins < nextDeparture.dep.expected_mins) {
        nextDeparture = { stop, dep };
      }
    }
  }
  const nextDepParsedMs = nextDeparture?.dep.expected_time_iso
    ? Date.parse(nextDeparture.dep.expected_time_iso)
    : NaN;
  const nextDepTargetMs = Number.isFinite(nextDepParsedMs) ? nextDepParsedMs : null;
  // Share of a 30-minute departure-board window already elapsed (0..1)
  const nextDepProgress = nextDeparture
    ? Math.min(Math.max(1 - nextDeparture.dep.expected_mins / 30, 0), 1)
    : 0;

  /** Render a single option card — shared between search results, after-class recs, and class recommendations. */
  const renderOptionCard = (
    opt: RecommendationOption,
    index: number,
    key: string,
    isHighlighted: boolean,
    onStart: () => void,
    destName: string = "destination",
    classStartTime?: string
  ) => {
    const isWalk = opt.type === "WALK";
    const isBestBus = !isWalk && index === 0;
    const label = getRouteLabel(opt, index);
    const stepFlow = buildStepFlow(opt.steps);
    const departMins = Math.round(opt.depart_in_minutes);
    const departNow = departMins <= 1;
    const accentColor = isWalk || isBestBus ? theme.colors.orange : theme.colors.border;
    const status = optionStatus(opt, classStartTime);
    // Deep status tokens — AA-safe as fills behind white pill text
    const statusColors: Record<string, string> = {
      'on-time': theme.colors.successDeep,
      'tight': theme.colors.warningDeep,
      'late': theme.colors.errorDeep,
      'walk-only': theme.colors.navy,
    };
    const statusLabels: Record<string, string> = {
      'on-time': 'ON TIME',
      'tight': 'TIGHT',
      'late': 'LATE',
      'walk-only': 'WALK',
    };
    const walkMins = Math.round(sumWalkingMinutes(opt.steps));
    // Status pill is ALWAYS rendered as text — the tinted border is never the
    // only signal. Without a class deadline the pill states the trip length.
    const hasDeadlineStatus = !!classStartTime;
    const pillBg = hasDeadlineStatus ? statusColors[status] : theme.colors.navyLight;
    const pillLabel = hasDeadlineStatus
      ? statusLabels[status]
      : isWalk
        ? 'WALK'
        : `${opt.eta_minutes} MIN TRIP`;
    // The primary CTA earns a beacon only once the bus is actually leaving.
    const isDepartingNow = index === 0 && !isWalk && opt.depart_in_minutes <= 0;
    // Whole minutes only — a label that changed every second would make
    // VoiceOver interrupt itself forever.
    const cardLabel = isWalk
      ? `Walk to ${destName}, ${opt.eta_minutes} minute walk`
      : `${label} to ${destName}, ${pillLabel.toLowerCase()}, ${
          departMins <= 0 ? "departing now" : `departs in ${departMins} minutes`
        }, ${opt.eta_minutes} minute trip`;

    return (
      <Press
        key={key}
        variant="lift"
        onPress={onStart}
        // `Press` defaults to a tap haptic on press-IN, and Pressable's
        // delayPressIn is 0 — so with the whole card as the press surface,
        // every scroll gesture that starts on a card would tick. The inner
        // Start and Share buttons keep their own haptics.
        haptic={false}
        accessibilityRole="button"
        // The card is a sighted-user shortcut to its own "Start" button. Left
        // accessible, it would swallow the Share and Start buttons inside it
        // into one VoiceOver element; false keeps both of them reachable. The
        // trip summary is announced by the info row below instead.
        accessible={false}
        style={[
          styles.optionCard,
          { borderLeftColor: hasDeadlineStatus ? statusColors[status] : accentColor },
          isHighlighted && styles.optionCardHighlight,
        ]}
      >
        <DepartingEdgeHaptic departing={isDepartingNow} />
        {/* Main row: info left | countdown right.
            Also the card's a11y summary. `Press` above is `accessible={false}`
            on purpose — grouping there would swallow Share and Start into one
            element — so the label has to land on the largest node that holds no
            controls. That is this row: VoiceOver reads one trip summary instead
            of six fragments, and Share and Start stay separately reachable. */}
        <View style={styles.cardMainRow} accessible accessibilityLabel={cardLabel}>
          {/* Left column: badge + flow + total */}
          <View style={styles.cardLeftCol}>
            <View style={styles.cardBadgeRow}>
              <View style={[styles.cardTypeBadge, isWalk ? styles.cardTypeBadgeWalk : styles.cardTypeBadgeBus]}>
                <Text style={styles.cardTypeBadgeText}>{label}</Text>
              </View>
              <View style={[styles.optionStatusPill, { backgroundColor: pillBg }]}>
                <Text style={styles.optionStatusText}>{pillLabel}</Text>
              </View>
              {walkMins > 0 && (
                <View style={styles.walkBadge}>
                  <Footprints size={11} color={theme.colors.textSecondary} strokeWidth={2.2} />
                  <Text style={styles.walkBadgeText}>{walkMins} min walk</Text>
                </View>
              )}
            </View>
            {stepFlow.length > 0 && (
              <Text style={styles.stepFlowText} numberOfLines={2}>{stepFlow}</Text>
            )}
            <Text style={styles.cardTotalTime}>
              {isWalk ? "Walk only" : `${opt.eta_minutes} min total`}
            </Text>
          </View>

          {/* Right column: hero countdown (tabular digits roll on refresh) */}
          <View style={styles.cardCountdownCol}>
            {departNow && !isWalk ? (
              <PulseView minOpacity={0.55} duration={700}>
                <Text style={styles.cardDepartNow}>Now</Text>
              </PulseView>
            ) : (
              <AnimatedNumber
                value={isWalk ? opt.eta_minutes : departMins}
                style={departNow ? styles.cardDepartNow : styles.cardDepartTime}
                accessibilityLabel={
                  isWalk ? `${opt.eta_minutes} minute walk` : `departs in ${departMins} minutes`
                }
              />
            )}
            <Text style={styles.cardDepartUnit}>
              {isWalk ? "min walk" : departNow ? "departing" : "min"}
            </Text>
          </View>
        </View>

        {/* AI explanation — clamped, quoted */}
        {opt.ai_explanation && (
          <View style={styles.aiQuoteWrap}>
            <Text style={styles.aiExplanation} numberOfLines={2}>{'“'}{opt.ai_explanation}{'”'}</Text>
          </View>
        )}

        {/* Footer row: MTD free + actions */}
        <View style={styles.cardBottomRow}>
          {!isWalk && <Text style={styles.mtdFree}>MTD · Free</Text>}
          <View style={{ flex: 1 }} />
          <View style={styles.cardActions}>
            <PressableScale
              accessibilityLabel="Share trip with live ETA"
              accessibilityRole="button"
              style={styles.shareBtn}
              onPress={() => handleShare(opt, destName)}
            >
              <Text style={styles.shareBtnText}>Share</Text>
            </PressableScale>
            <View style={styles.startBtnBeaconWrap}>
              {/* Halo, not a loop: one ring every 4s while the bus is leaving. */}
              <Beacon
                size={theme.layout.tapMin}
                color={theme.colors.orangeBright}
                period={4000}
                active={isDepartingNow}
                style={styles.startBtnBeacon}
              />
              <PressableScale
                accessibilityLabel={isWalk ? "Start walking directions" : "Start bus option"}
                accessibilityRole="button"
                style={styles.startBtnInline}
                onPress={onStart}
              >
                <LinearGradient
                  colors={[theme.gradients.sunset[0], theme.gradients.sunset[1]]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.startBtnInlineGradient}
                >
                  <Text style={styles.startBtnInlineText}>Start →</Text>
                </LinearGradient>
              </PressableScale>
            </View>
          </View>
        </View>
      </Press>
    );
  };

  return (
    <CollapsingHeader
      style={styles.screen}
      maxHeight={insets.top + HERO_BODY_HEIGHT}
      minHeight={insets.top + STRIP_BODY_HEIGHT}
      fadeWindow={STRIP_FADE_WINDOW}
      backgroundColor={theme.gradients.hero[0]}
      borderColor="rgba(255,255,255,0.14)"
      contentContainerStyle={styles.scrollContent}
      scrollViewProps={{
        ref: scrollRef,
        keyboardShouldPersistTaps: "handled",
        refreshControl: (
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />
        ),
      }}
      // The strip is mounted for the whole life of the screen and only
      // cross-fades, so its countdown KEEPS TICKING while collapsed instead of
      // remounting at the moment the user most needs it.
      renderCompact={({ collapsed }) => (
        // Rendered unconditionally, even with no departure to show. The band is
        // painted opaque navy by the header's background layer either way, so
        // the barrier below has to exist either way — an empty strip that still
        // swallowed taps meant for the card under it would be the same bug.
        <View
          // Once collapsed, this strip owns the top of the screen and the search
          // card with its "Where to?" input sits directly underneath. Left
          // touch-transparent it stays invisible to the touch system, so a tap
          // on what looks like a header falls through and focuses the keyboard.
          // `collapsed` is the primitive's single JS-thread boolean, flipped
          // once per cross-fade crossing rather than once per frame — and it is
          // false at scroll 0, where "auto" would eat the pull-to-refresh.
          pointerEvents={collapsed ? "auto" : "none"}
          style={[styles.stickyStrip, { paddingTop: insets.top }]}
        >
          {nextDeparture && (
            <View style={styles.stickyRow}>
              <View style={styles.heroRoutePill}>
                <Text style={styles.heroRoutePillText}>{nextDeparture.dep.route}</Text>
              </View>
              <Text style={styles.stickyHeadsign} numberOfLines={1}>
                {nextDeparture.dep.headsign || "—"}
              </Text>
              <Text style={styles.stickyMode}>
                {nextDeparture.dep.is_realtime ? "LIVE" : "SCHED"}
              </Text>
              <TickingCountdown
                targetMs={nextDepTargetMs}
                minutes={nextDeparture.dep.expected_mins}
                style={styles.stickyCountdown}
              />
            </View>
          )}
        </View>
      )}
      renderHero={({ progress: heroProgress }) => (
        <LinearGradient
          colors={[theme.gradients.hero[0], theme.gradients.hero[1], theme.gradients.hero[2]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          // Touch-transparent: the hero owns no controls, and the header now
          // floats OVER the scroll view. Anything but "none" here would let the
          // hero swallow a drag that starts on it instead of scrolling the page.
          pointerEvents="none"
          style={[styles.heroBlock, { paddingTop: insets.top + 16 }]}
        >
          <Stagger dy={10}>
            <HeroFade progress={heroProgress} to={0.7}>
              <View>
                <Text style={styles.heroGreeting}>{getGreeting()}</Text>
                <Text style={styles.heroDate}>
                  {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </Text>
                {nextUp && (
                  <View style={styles.heroNextChip}>
                    <PulseView minOpacity={0.4} style={styles.heroNextDot}>
                      <View style={styles.heroNextDotInner} />
                    </PulseView>
                    <Text style={styles.heroNextText} numberOfLines={1}>
                      Next: {nextUp.title} · {nextUp.start_time_local}
                    </Text>
                  </View>
                )}
              </View>
            </HeroFade>

            {/* Next-departure marquee — the one bus that matters right now */}
            <HeroFade progress={heroProgress} from={0.45} dy={14}>
              {nextDeparture ? (
                <View
                  style={styles.heroMarquee}
                  accessible
                  accessibilityLabel={`Next departure: route ${nextDeparture.dep.route} to ${nextDeparture.dep.headsign || "campus"}, from ${nextDeparture.stop.stop_name}, ${nextDeparture.dep.expected_mins <= 0 ? "departing now" : `in ${nextDeparture.dep.expected_mins} minutes`}${nextDeparture.dep.is_realtime ? ", live tracking" : ", scheduled time"}`}
                >
                  <View style={styles.heroMarqueeLeft}>
                    <Text style={styles.heroMarqueeEyebrow}>Next departure</Text>
                    <View style={styles.heroMarqueeRouteRow}>
                      <View style={styles.heroRoutePill}>
                        <Text style={styles.heroRoutePillText}>{nextDeparture.dep.route}</Text>
                      </View>
                      <Text style={styles.heroMarqueeHeadsign} numberOfLines={1}>
                        {nextDeparture.dep.headsign || "—"}
                      </Text>
                    </View>
                    <View style={styles.heroMarqueeStopRow}>
                      <MapPin size={11} color={theme.colors.textOnNavyMuted} />
                      <Text style={styles.heroMarqueeStop} numberOfLines={1}>
                        {nextDeparture.stop.stop_name} · {formatDistance(nextDeparture.stop.distance_m)}
                      </Text>
                    </View>
                    <View style={styles.heroProgressTrack}>
                      <View style={[styles.heroProgressFill, { width: `${Math.round(nextDepProgress * 100)}%` }]} />
                    </View>
                  </View>
                  <View style={styles.heroMarqueeRight}>
                    <TickingCountdown
                      targetMs={nextDepTargetMs}
                      minutes={nextDeparture.dep.expected_mins}
                      style={styles.heroMarqueeCountdown}
                    />
                    <Badge
                      label={nextDeparture.dep.is_realtime ? "LIVE" : "Scheduled"}
                      variant={nextDeparture.dep.is_realtime ? "live" : "info"}
                      size="sm"
                    />
                  </View>
                </View>
              ) : departures.anyPending ? (
                <View style={styles.heroMarquee}>
                  <View style={styles.heroMarqueeLeft}>
                    <Text style={styles.heroMarqueeEyebrow}>Next departure</Text>
                    <Skeleton width="72%" height={20} style={styles.heroMarqueeSkeleton} />
                    <Skeleton width="46%" height={12} style={styles.heroMarqueeSkeleton} />
                  </View>
                </View>
              ) : (
                <View
                  style={styles.heroMarquee}
                  accessible
                  accessibilityLabel="Departure board: no buses due at your nearby stops right now"
                >
                  <View style={styles.heroMarqueeLeft}>
                    <Text style={styles.heroMarqueeEyebrow}>Departure board</Text>
                    <Text style={styles.heroMarqueeHeadsign}>All quiet at your stops</Text>
                    <Text style={styles.heroMarqueeStop} numberOfLines={2}>
                      No buses due nearby right now — campus is very walkable
                    </Text>
                  </View>
                  <View style={styles.heroMarqueeRight}>
                    <Footprints size={26} color={theme.colors.textOnNavyMuted} strokeWidth={1.8} />
                  </View>
                </View>
              )}
            </HeroFade>
          </Stagger>
        </LinearGradient>
      )}
    >
      {/* Search card — first card below the collapsing hero */}
      <FadeInView delay={70} style={styles.searchCard}>
        <Text style={styles.searchLabel} accessibilityRole="header">Where to?</Text>
        {(homePlace || pinnedRoutes.length > 0) && !searchQuery.trim() && !searchLoading && (
          <View style={styles.quickChipsRow}>
            {homePlace && (
              <PressableScale
                style={styles.homePlaceChip}
                onPress={onGetMeHome}
                accessibilityLabel={`Get me to ${homePlace.name}`}
                accessibilityRole="button"
              >
                <Text style={styles.homePlaceChipText}>→ {homePlace.name}</Text>
              </PressableScale>
            )}
            {pinnedRoutes.map((pin) => (
              <PressableScale
                key={pin.id}
                style={styles.pinnedChip}
                accessibilityRole="button"
                accessibilityLabel={`Get routes to pinned destination ${pin.destName}. Long press to unpin.`}
                onPress={async () => {
                  setSearchQuery(pin.destName);
                  setSearchLoading(true);
                  setSearchResults([]);
                  setSearchDestinationName(null);
                  setSearchDestSaved(false);
                  setSearchError(null);
                  setSuppressAutocomplete(true);
                  try {
                    await _fetchRoutesTo(pin.destLat, pin.destLng, pin.destName, pin.destName);
                  } catch (e) {
                    setSearchError(e instanceof Error ? e.message : "Search failed.");
                  } finally {
                    setSearchLoading(false);
                  }
                }}
                onLongPress={async () => {
                  Alert.alert("Remove pin", `Unpin "${pin.destName}"?`, [
                    { text: "Cancel", style: "cancel" },
                    { text: "Remove", style: "destructive", onPress: async () => {
                      await removePinnedRoute(pin.id);
                      setPinnedRoutes(await getPinnedRoutes());
                    }},
                  ]);
                }}
              >
                <Text style={styles.pinnedChipText}>{pin.destName}</Text>
              </PressableScale>
            ))}
          </View>
        )}
        <View style={styles.searchInputWrapper}>
          <Search size={18} color={theme.colors.textMuted} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="e.g. Siebel, Illini Union, or an address"
            placeholderTextColor={theme.colors.textMuted}
            value={searchQuery}
            onChangeText={(t) => { setSearchQuery(t); setSearchError(null); setSuppressAutocomplete(false); }}
            onSubmitEditing={onSearchDestination}
            editable={!searchLoading}
          />
          {searchQuery.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={14}
              onPress={() => { setSearchQuery(""); setSuppressAutocomplete(true); setSearchError(null); }}
            >
              <X size={16} color={theme.colors.textMuted} />
            </Pressable>
          )}
        </View>
        {autocompleteSuggestions.length > 0 && (
          <View style={styles.suggestionsList}>
            {autocompleteSuggestions.map((item, i) => (
              <View key={`${item.type}-${i}`} style={styles.suggestionItem}>
                <Pressable
                  style={styles.suggestionMain}
                  onPress={() => onSelectSuggestion(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Get routes to ${item.name}`}
                >
                  <View style={styles.suggestionRow}>
                    <View style={styles.suggestionIconWrap}>
                      {item.type === "building" ? (
                        <MapPin size={14} color={theme.colors.brandInk} />
                      ) : (
                        <Search size={14} color={theme.colors.textMuted} />
                      )}
                    </View>
                    <Text style={styles.suggestionText} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {item.type === "building" && (
                      <Text style={styles.suggestionType}>UIUC</Text>
                    )}
                  </View>
                  {(item.secondary_text || (item.display_name && item.display_name !== item.name)) && (
                    <Text style={styles.suggestionSub} numberOfLines={1}>
                      {item.secondary_text || item.display_name?.split(",").slice(1, 3).join(",").trim()}
                    </Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.suggestionSaveBtn}
                  accessibilityRole="button"
                  accessibilityLabel={`Save ${item.name} as favorite`}
                  hitSlop={6}
                  onPress={async () => {
                    const name = item.name;
                    let lat = item.lat;
                    let lng = item.lng;
                    if (item.type === "google_place" && item.place_id && (lat === 0 || lng === 0)) {
                      try {
                        const details = await fetchPlaceDetails(apiBaseUrl, item.place_id, { apiKey: apiKey ?? undefined });
                        lat = details.lat;
                        lng = details.lng;
                      } catch {}
                    }
                    await addFavoritePlace({ name, lat, lng });
                    setSavedPlaceNames((prev) => new Set([...prev, name]));
                  }}
                >
                  <Star size={18} color={theme.colors.orange} fill={savedPlaceNames.has(item.name) ? theme.colors.orange : "none"} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <PressableScale
          scaleTo={0.97}
          style={[styles.searchBtn, searchLoading && styles.searchBtnDisabled]}
          // onSearchDestination fires its own haptic — no second one here.
          onPress={onSearchDestination}
          disabled={searchLoading || !searchQuery.trim() || !location}
          accessibilityRole="button"
          accessibilityLabel="Get routes"
          accessibilityState={{ disabled: searchLoading || !searchQuery.trim() || !location, busy: searchLoading }}
        >
          <LinearGradient
            colors={[theme.gradients.sunset[0], theme.gradients.sunset[1]]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.searchBtnGradient}
          >
            {searchLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.searchBtnText}>Get routes</Text>
            )}
          </LinearGradient>
        </PressableScale>
        {searchError && <Text style={styles.searchError}>{searchError}</Text>}
        {recentSearches.length > 0 && !searchResults.length && !autocompleteSuggestions.length && (
          <View style={styles.recentSearches}>
            <View style={styles.recentHeader}>
              <Text style={styles.recentLabel}>Recent</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear recent searches"
                hitSlop={14}
                onPress={async () => {
                await clearRecentSearches();
                setRecentSearches([]);
              }}>
                <Text style={styles.recentClearBtn}>Clear</Text>
              </Pressable>
            </View>
            <View style={styles.recentChipsWrap}>
              {recentSearches.map((r, i) => (
                <PressableScale
                  key={i}
                  scaleTo={0.94}
                  style={styles.recentChip}
                  onPress={() => setSearchQuery(r.query)}
                  accessibilityRole="button"
                  accessibilityLabel={`Search again for ${r.displayName.split(",")[0]}`}
                  hitSlop={{ top: 4, bottom: 4 }}
                >
                  <Clock size={13} color={theme.colors.textMuted} />
                  <Text style={styles.recentChipText} numberOfLines={1}>{r.displayName.split(",")[0]}</Text>
                </PressableScale>
              ))}
            </View>
          </View>
        )}
      </FadeInView>

      {/* Search in flight — skeleton route cards, not spinners */}
      {searchLoading && (
        <View style={styles.searchSkeletonWrap}>
          <Skeleton width="100%" height={128} radius={theme.radius.xl} />
          <Skeleton width="100%" height={128} radius={theme.radius.xl} />
        </View>
      )}

      {bannerText && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>{bannerText}</Text>
          <Pressable onPress={onRefresh} accessibilityRole="button" accessibilityLabel="Retry loading" hitSlop={14}>
            <Text style={styles.offlineBannerRetry}>Retry</Text>
          </Pressable>
        </View>
      )}
      {useUiucArea && (
        <View style={styles.uiucBanner}>
          <Text style={styles.uiucBannerText}>Showing UIUC area (Champaign-Urbana) for testing</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Use my location"
            hitSlop={14}
            onPress={() => { setUseUiucArea(false); detectLocation(); }}
          >
            <Text style={styles.uiucBannerLink}>Use my location</Text>
          </Pressable>
        </View>
      )}
      {rainMode && (
        <View style={styles.rainBanner}>
          <Text style={styles.rainBannerText}>Rain mode on — bus routes prioritised, +5 min buffer</Text>
          {/* Decorative — the banner text already says it all. A no-op Pressable
              here was an a11y "button" that did nothing. */}
          <Text
            style={styles.rainBannerIcon}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            ☂
          </Text>
        </View>
      )}

      {/* Search results */}
      {searchDestinationName && searchResults.length > 0 && (
        <View style={styles.recommendationsSection}>
          <View style={styles.searchResultsHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionTitle, { marginBottom: 0 }]} accessibilityRole="header">Routes to</Text>
              <Text style={styles.sectionSubtitle}>{searchDestinationName.split(",")[0]}</Text>
            </View>
            {lastSearchGeo && (
              <View style={styles.searchResultActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={searchDestPinned ? "Destination pinned" : "Pin this destination for quick access"}
                  hitSlop={10}
                  onPress={async () => {
                    if (searchDestPinned) return;
                    await addPinnedRoute({ destName: searchDestinationName.split(",")[0], destLat: lastSearchGeo.lat, destLng: lastSearchGeo.lng });
                    setPinnedRoutes(await getPinnedRoutes());
                    setSearchDestPinned(true);
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                    {searchDestPinned && <MapPin size={12} color={theme.colors.textSecondary} />}
                    <Text style={styles.pinBtn}>{searchDestPinned ? "Pinned" : "Pin"}</Text>
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={searchDestSaved ? "Destination saved to favorites" : "Save this destination to favorites"}
                  hitSlop={10}
                  onPress={async () => {
                    if (searchDestSaved) return;
                    const name = searchDestinationName.split(",")[0];
                    await addFavoritePlace({ name, lat: lastSearchGeo.lat, lng: lastSearchGeo.lng });
                    setSearchDestSaved(true);
                    setSavedPlaceNames((prev) => new Set([...prev, name]));
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                    <Star size={12} color={theme.colors.orange} fill={searchDestSaved ? theme.colors.orange : "none"} />
                    <Text style={styles.saveFavBtn}>{searchDestSaved ? "Saved" : "Save"}</Text>
                  </View>
                </Pressable>
              </View>
            )}
          </View>
          {/* Sort toggle */}
          <View style={[styles.sortRow, { paddingHorizontal: theme.spacing.lg }]}>
            {(['earliest', 'fastest', 'least-walk'] as const).map((s) => {
              const labels = { earliest: 'Arrives first', fastest: 'Fastest', 'least-walk': 'Fewest steps' };
              const active = routeSort === s;
              return (
                <PressableScale
                  key={s}
                  scaleTo={0.93}
                  style={[styles.sortPill, active && styles.sortPillActive]}
                  onPress={() => setRouteSort(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`Sort routes: ${labels[s]}`}
                  accessibilityState={{ selected: active }}
                  hitSlop={{ top: 8, bottom: 8 }}
                >
                  <Text style={[styles.sortPillText, active && styles.sortPillTextActive]}>{labels[s]}</Text>
                </PressableScale>
              );
            })}
          </View>
          <Stagger step={STAGGER.listStep} cap={STAGGER.listCap}>
            {sortedOptions(searchResults).map((opt, index) => {
              const isWalk = opt.type === "WALK";
              return (
                <OptionCardWithCrowding key={`search-${index}`} option={opt}>
                  {renderOptionCard(
                    opt,
                    index,
                    `search-${index}`,
                    false,
                    () => (isWalk ? onStartWalk(opt, searchDestinationName?.split(",")[0]) : onStartBus(opt)),
                    searchDestinationName?.split(",")[0] ?? "destination"
                  )}
                </OptionCardWithCrowding>
              );
            })}
          </Stagger>
          {/* Smart callouts for search results */}
          {(() => {
            const walkOpt = searchResults.find((o) => o.type === 'WALK');
            const busOpts = searchResults.filter((o) => o.type !== 'WALK');
            const busBestEta = busOpts.length > 0 ? Math.min(...busOpts.map((o) => o.eta_minutes)) : null;
            if (walkOpt && busBestEta !== null && walkOpt.eta_minutes <= busBestEta + 4) {
              return (
                <Text style={styles.smartCallout}>Walking is almost as fast — and you'll get your steps</Text>
              );
            }
            return null;
          })()}
        </View>
      )}

      {/* Leave By Smart Card */}
      {leaveBy.nextClass && leaveBy.options.length > 0 && (
        <FadeInView delay={100}>
        <LinearGradient
          colors={[theme.gradients.ember[0], theme.gradients.ember[1]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.leaveByCard}
        >
          <View style={styles.leaveByHeader}>
            <Text style={styles.leaveByTitle}>{leaveBy.nextClass.title}</Text>
            <Text style={styles.leaveByTime}>{leaveBy.nextClass.start_time_local}</Text>
          </View>
          {leaveBy.options.slice(0, 2).map((opt, i) => (
            <View key={i} style={styles.leaveByRow}>
              <View style={[styles.leaveByStatusPill, { backgroundColor: opt.status === 'on-time' ? theme.colors.successDeep : opt.status === 'tight' ? theme.colors.warningDeep : theme.colors.errorDeep }]}>
                <Text style={styles.leaveByStatusText}>{opt.status === 'on-time' ? 'ON TIME' : opt.status === 'tight' ? 'TIGHT' : 'LATE'}</Text>
              </View>
              <Text style={styles.leaveByRouteText}>Route {opt.routeId}</Text>
              <Text style={styles.leaveBySummary}>Leave in {Math.max(0, Math.round((opt.departureEpochMs - Date.now()) / 60000))} min · {opt.totalTimeMins} min total</Text>
            </View>
          ))}
          {leaveBy.noViableBus && leaveBy.walkOnlyMins != null && (
            <Text style={styles.leaveByWalkFallback}>No bus on time — walk {leaveBy.walkOnlyMins} min</Text>
          )}
        </LinearGradient>
        </FadeInView>
      )}

      {/* Running late? trigger */}
      {leaveBy.nextClass && leaveBy.options.some((o) => o.marginMins < 10) && (
        <PulseView minOpacity={0.85} maxScale={1.03} duration={1100} style={{ alignSelf: 'flex-start' }}>
          <PressableScale
            style={styles.runningLatePill}
            onPress={() => router.push('/running-late')}
            accessibilityLabel="Running late? See catchable buses"
            accessibilityRole="button"
          >
            <Text style={styles.runningLatePillText}>Running late?</Text>
          </PressableScale>
        </PulseView>
      )}

      {/* Leave Now Banner */}
      {leaveNowBanner && (
        <View style={styles.leaveNowBanner}>
          <View style={styles.leaveNowLeft}>
            <Text style={styles.leaveNowTitle}>
              {buildLeaveNowBody(leaveNowBanner.option, leaveNowBanner.classTitle).title}
            </Text>
            <Text style={styles.leaveNowBody} numberOfLines={1}>
              {buildLeaveNowBody(leaveNowBanner.option, leaveNowBanner.classTitle).body}
            </Text>
          </View>
          <Pressable
            style={styles.leaveNowStartBtn}
            accessibilityRole="button"
            accessibilityLabel="Start this route now"
            onPress={() => {
              setLeaveNowBanner(null);
              if (leaveNowBanner.option.type === "WALK") onStartWalk(leaveNowBanner.option);
              else onStartBus(leaveNowBanner.option);
            }}
          >
            <Text style={styles.leaveNowStartBtnText}>Start</Text>
          </Pressable>
          <Pressable
            style={styles.leaveNowDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss leave-now alert"
            hitSlop={8}
            onPress={() => setLeaveNowBanner(null)}
          >
            <X size={16} color={theme.colors.textOnNavyMuted} />
          </Pressable>
        </View>
      )}

      {/* Section divider — separates search results from class schedule block */}
      <View style={styles.scheduleSectionDivider}>
        <View style={styles.scheduleSectionLine} />
        <Text style={styles.scheduleSectionLabel} accessibilityRole="header">Your schedule</Text>
        <View style={styles.scheduleSectionLine} />
      </View>

      {/* Next up card */}
      <FadeInView delay={60} style={styles.nextUpCard}>
        <View style={styles.nextUpLabelRow}>
          <Text style={styles.nextUpLabel}>Next up</Text>
          <NextUpArrow />
        </View>
        {nextUp ? (
          <>
            <View style={styles.nextUpBodyRow}>
              <View style={styles.nextUpClassInfo}>
                <Text style={styles.nextUpText}>{nextUp.title}</Text>
                <Text style={styles.nextUpTime}>{nextUp.start_time_local}</Text>
                <Pressable
                  style={styles.walkingToClassBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Scroll to route options for this class"
                  hitSlop={{ top: 14, bottom: 14 }}
                  onPress={() => scrollRef.current?.scrollTo({ y: recommendationsY.current, animated: true })}
                >
                  <Text style={styles.walkingToClassBtnText}>How are you getting there? →</Text>
                </Pressable>
              </View>
              {recommendations.length > 0 && (
                <View style={styles.nextUpWalkBadge}>
                  <Text style={styles.nextUpWalkBadgeNum}>{sumWalkingMinutes(recommendations[0].steps)}</Text>
                  <Text style={styles.nextUpWalkBadgeUnit}>min{"\n"}walking</Text>
                </View>
              )}
            </View>
          </>
        ) : (
          <>
            <Text style={styles.nextUpText}>No more classes today.</Text>
            <Pressable
              style={styles.planEveningBtn}
              accessibilityRole="button"
              accessibilityLabel="Plan my evening"
              hitSlop={{ top: 14, bottom: 14 }}
              onPress={() => router.push("/after-class-planner")}
            >
              <Text style={styles.planEveningBtnText}>Plan my evening →</Text>
            </Pressable>
          </>
        )}
      </FadeInView>

      {nextUp && recommendations.length === 0 && (
        recPending ? (
          <View style={styles.recSkeletonWrap}>
            <Skeleton width="100%" height={132} radius={theme.radius.xl} />
            <Skeleton width="100%" height={132} radius={theme.radius.xl} />
          </View>
        ) : (
          <View style={styles.recommendationsUnavailable}>
            <Text style={styles.recommendationsUnavailableText}>
              Route options unavailable. Pull down to refresh.
            </Text>
          </View>
        )
      )}

      {/* After-last-class recommendations */}
      {!nextUp && afterLastClassPlace && afterLastClassRecs.length > 0 && (
        <View style={styles.recommendationsSection}>
          <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg }}>
            <Text style={[styles.sectionTitle, { marginBottom: 0, paddingHorizontal: 0, paddingTop: 0 }]} accessibilityRole="header">Where to next?</Text>
            <Text style={styles.sectionSubtitle}>{afterLastClassPlace.name}</Text>
          </View>
          <Stagger step={STAGGER.listStep} cap={STAGGER.listCap}>
            {afterLastClassRecs.map((opt, index) => {
              const isWalk = opt.type === "WALK";
              return (
                <OptionCardWithCrowding key={`after-${index}`} option={opt}>
                  {renderOptionCard(
                    opt,
                    index,
                    `after-${index}`,
                    false,
                    () => (isWalk ? onStartWalk(opt) : onStartBus(opt)),
                    afterLastClassPlace?.name ?? "destination"
                  )}
                </OptionCardWithCrowding>
              );
            })}
          </Stagger>
        </View>
      )}

      {/* Class recommendations */}
      {nextUp && recommendations.length > 0 && (
        <View
          style={styles.recommendationsSection}
          onLayout={(e: LayoutChangeEvent) => {
            recommendationsY.current = e.nativeEvent.layout.y;
          }}
        >
          <View style={styles.getThereHeader}>
            <Text style={styles.getThereTitle} accessibilityRole="header">Get there</Text>
            <Text style={styles.sectionSubtitle}>{nextUp.title}</Text>
          </View>
          {/* Sort toggle for class recommendations */}
          <View style={[styles.sortRow, { paddingHorizontal: theme.spacing.lg }]}>
            {(['earliest', 'fastest', 'least-walk'] as const).map((s) => {
              const labels = { earliest: 'Arrives first', fastest: 'Fastest', 'least-walk': 'Fewest steps' };
              const active = routeSort === s;
              return (
                <PressableScale
                  key={s}
                  scaleTo={0.93}
                  style={[styles.sortPill, active && styles.sortPillActive]}
                  onPress={() => setRouteSort(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`Sort routes: ${labels[s]}`}
                  accessibilityState={{ selected: active }}
                  hitSlop={{ top: 8, bottom: 8 }}
                >
                  <Text style={[styles.sortPillText, active && styles.sortPillTextActive]}>{labels[s]}</Text>
                </PressableScale>
              );
            })}
          </View>
          <Stagger step={STAGGER.listStep} cap={STAGGER.listCap}>
            {sortedOptions(recommendations).map((opt, index) => {
              const isWalk = opt.type === "WALK";
              const allBusLate = recommendations.filter((o) => o.type !== 'WALK').every((o) => optionStatus(o, nextUp?.start_time_local) === 'late');
              const highlighted = (isWalk && highlightWalk) || (isWalk && allBusLate);
              return (
                <OptionCardWithCrowding key={`rec-${index}`} option={opt}>
                  {renderOptionCard(
                    opt,
                    index,
                    `rec-${index}`,
                    highlighted,
                    () => (isWalk ? onStartWalk(opt) : onStartBus(opt)),
                    nextUp?.title ?? "class",
                    nextUp?.start_time_local
                  )}
                </OptionCardWithCrowding>
              );
            })}
          </Stagger>
          {/* Crowding banner for top bus recommendation */}
          {(() => {
            const rideStep = recommendations[0]?.steps?.find(s => s.type === "RIDE");
            if (!rideStep?.vehicle_id || !rideStep?.route_id) return null;
            return (
              <CrowdingBanner
                vehicleId={rideStep.vehicle_id}
                routeId={rideStep.route_id}
              />
            );
          })()}
          {/* Smart callouts for class recommendations */}
          {(() => {
            const walkOpt = recommendations.find((o) => o.type === 'WALK');
            const busOpts = recommendations.filter((o) => o.type !== 'WALK');
            const busBestEta = busOpts.length > 0 ? Math.min(...busOpts.map((o) => o.eta_minutes)) : null;
            const allBusLate = busOpts.length > 0 && busOpts.every((o) => optionStatus(o, nextUp?.start_time_local) === 'late');
            const callouts: React.JSX.Element[] = [];
            if (walkOpt && busBestEta !== null && walkOpt.eta_minutes <= busBestEta + 4) {
              callouts.push(
                <Text key="walk-callout" style={styles.smartCallout}>
                  Walking is almost as fast — and you'll get your steps
                </Text>
              );
            }
            if (nextUp?.start_time_local && busOpts.length > 0) {
              const now = new Date();
              const nowMins = now.getHours() * 60 + now.getMinutes();
              const [ch, cm] = nextUp.start_time_local.split(':').map(Number);
              const classMins = (ch ?? 0) * 60 + (cm ?? 0);
              const bestBus = busOpts.reduce((a, b) => a.eta_minutes < b.eta_minutes ? a : b);
              // eta_minutes already includes the wait — arrival is now + eta
              const arrivalMins = nowMins + bestBus.eta_minutes;
              const margin = classMins - arrivalMins;
              const destContainsClass = searchDestinationName
                ? nextUp.title.toLowerCase().split(' ').some((w) => w.length > 3 && searchDestinationName.toLowerCase().includes(w))
                : false;
              if (destContainsClass && margin > 0) {
                callouts.push(
                  <Text key="class-callout" style={[styles.smartCallout, styles.smartCalloutGreen]}>
                    Gets you to {nextUp.title} with {Math.round(margin)} min to spare
                  </Text>
                );
              }
            }
            if (allBusLate && walkOpt) {
              callouts.push(
                <Text key="late-callout" style={styles.smartCallout}>
                  All buses are late — walking may be your best bet
                </Text>
              );
            }
            return callouts.length > 0 ? <>{callouts}</> : null;
          })()}
        </View>
      )}

      {/* Nearby stops */}
      <Text style={styles.stopsSectionTitle} accessibilityRole="header">Nearby stops</Text>
      {stops.length > 0 &&
        !departures.anyPending &&
        !departures.anyError &&
        departures.hasData &&
        stops.every((s) => (departuresByStop[s.stop_id]?.length ?? 0) === 0) && (
          <View style={styles.mtdHint}>
            <Text style={styles.mtdHintText}>No upcoming departures at nearby stops. Buses may not be running at this time.</Text>
          </View>
        )}
      {stops.length === 0 ? (
        nearbyStopsError ? (
          // A failed query also leaves `data` undefined — without this branch
          // the skeletons below would shimmer forever on error.
          <EmptyState
            icon={MapPin}
            title="Couldn't load nearby stops"
            subtitle="Check your connection and try again."
            action={{ label: "Retry", onPress: onRefresh }}
          />
        ) : nearbyStopsData === undefined ? (
          <View style={styles.stopsSkeletonWrap}>
            <Skeleton width="100%" height={112} radius={theme.radius.xl} />
            <Skeleton width="100%" height={112} radius={theme.radius.xl} />
            <Skeleton width="100%" height={112} radius={theme.radius.xl} />
          </View>
        ) : (
          <EmptyState
            icon={MapPin}
            title="No stops in range"
            subtitle="Move closer to campus or pull down to refresh."
          />
        )
      ) : (
        <Stagger step={STAGGER.listStep} cap={STAGGER.listCap}>
          {stops.map((stop) => (
            <View key={stop.stop_id} style={styles.card}>
              <LinearGradient
                colors={[theme.gradients.ember[0], theme.gradients.ember[1]]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.stopCardHeader}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.stopName}>{stop.stop_name}</Text>
                  <Text style={styles.distance}>{formatDistance(stop.distance_m)} away</Text>
                </View>
                <PressableScale
                  style={styles.favoriteStopBtn}
                  accessibilityRole="button"
                  accessibilityLabel={`Save ${stop.stop_name} to favorite stops`}
                  hitSlop={8}
                  onPress={() => addFavoriteStop({ stop_id: stop.stop_id, stop_name: stop.stop_name })}
                >
                  <Star size={16} color={theme.colors.textOnNavyMuted} />
                </PressableScale>
              </LinearGradient>
              <View style={styles.departures}>
                {(departuresByStop[stop.stop_id] ?? []).length === 0 ? (
                  departures.anyPending ? (
                    <View style={styles.depSkeletonWrap}>
                      <Skeleton width="88%" height={14} />
                      <Skeleton width="66%" height={14} />
                    </View>
                  ) : (
                    <Text style={styles.depText}>No departures due</Text>
                  )
                ) : (
                  (departuresByStop[stop.stop_id] ?? []).slice(0, MAX_DEPARTURES_PER_STOP).map((d, i) => {
                    const fetchedAt = departures.updatedAtByStop[stop.stop_id] ?? 0;
                    const isStale = d.is_realtime && fetchedAt > 0 && Date.now() - fetchedAt > 2 * 60 * 1000;
                    const showDelayed = d.delay_status === "delayed" && d.delay_mins != null && d.delay_mins >= 3;
                    const showEarly = d.delay_status === "early" && d.delay_mins != null && Math.abs(d.delay_mins) >= 2;
                    return (
                      <View key={i}>
                        <Pressable
                          onPress={() => router.push({ pathname: "/route-tracker", params: { route_id: d.route, route_name: d.headsign } })}
                          // NOT an a11y element itself: a label here would hide
                          // the DepartureRow's real time/live/delay summary.
                          // The row inside stays the focusable element.
                          accessible={false}
                          accessibilityHint={`Opens live tracking for route ${d.route}`}
                        >
                          <DepartureRow
                            route={d.route}
                            headsign={d.headsign || "—"}
                            expectedMins={d.expected_mins}
                            isRealtime={d.is_realtime && !isStale}
                            expectedTimeIso={isStale ? null : d.expected_time_iso}
                            delayStatus={showDelayed ? "delayed" : showEarly ? "early" : null}
                            delayMins={showDelayed || showEarly ? d.delay_mins : null}
                          />
                        </Pressable>
                        {isStale && (
                          <View style={styles.depExtrasRow}>
                            <View style={styles.staleBadge}>
                              <Text style={styles.staleBadgeText}>⚠ Estimated</Text>
                            </View>
                          </View>
                        )}
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          ))}
        </Stagger>
      )}
    </CollapsingHeader>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: theme.colors.surfaceAlt,
  },
  centeredText: { marginTop: 12, fontFamily: "DMSans_400Regular", fontSize: 15, color: theme.colors.textSecondary },
  screen: { flex: 1, backgroundColor: theme.colors.surfaceAlt },
  scrollContent: { paddingBottom: 40, backgroundColor: theme.colors.surfaceAlt },

  // Sticky one-line departure strip — what the hero marquee collapses into.
  // Fills the collapsed band edge to edge, so the opaque navy the user sees and
  // the region that absorbs taps are the same rectangle. The hairline along its
  // bottom is the header's own, faded in once collapsed.
  stickyStrip: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: theme.gradients.hero[0],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: 10,
  },
  stickyRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  stickyHeadsign: { ...theme.text.subhead, fontSize: 14, color: theme.colors.textOnNavy, flex: 1, minWidth: 0 },
  // Live vs scheduled is stated in words, never by color alone.
  stickyMode: { ...theme.text.badge, fontSize: 10, color: theme.colors.textOnNavyMuted, letterSpacing: 0.8 },
  stickyCountdown: {
    fontFamily: "DMSans_700Bold",
    fontSize: 18,
    lineHeight: 22,
    color: theme.colors.textOnNavy,
  },

  // Nearby-stops loading state
  stopsSkeletonWrap: { marginHorizontal: theme.layout.gutter, gap: theme.layout.cardGap, marginBottom: theme.layout.cardGap },

  // Hero header. Fills the header box and anchors its content to the bottom:
  // the box is a fixed HERO_BODY_HEIGHT, so bottom-anchoring is what keeps the
  // marquee-to-search-card spacing identical whether or not the next-class chip
  // is present. The rubber-band overscroll above it is painted by the header's
  // own background overhang, which is why there is no bounce cover here.
  heroBlock: {
    flex: 1,
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.radius.xxl + 22,
  },
  heroGreeting: { fontSize: 32, fontFamily: "DMSerifDisplay_400Regular", color: "#fff", letterSpacing: -0.3 },
  heroDate: { fontSize: 13, fontFamily: "DMSans_400Regular", color: theme.colors.textOnNavyMuted, marginTop: 4 },
  heroNextChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 7,
    marginTop: 12,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: theme.radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  heroNextDot: { width: 7, height: 7 },
  heroNextDotInner: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.orangeBright },
  heroNextText: { fontFamily: "DMSans_500Medium", fontSize: 12, color: theme.colors.textOnNavy, maxWidth: 280 },

  // Next-departure marquee — frosted signage card on the navy hero
  heroMarquee: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.layout.cardGap,
    marginTop: theme.spacing.lg,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: theme.radius.xl,
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: 14,
  },
  heroMarqueeLeft: { flex: 1, minWidth: 0 },
  heroMarqueeRight: { alignItems: "flex-end", justifyContent: "center", gap: theme.spacing.sm },
  heroMarqueeEyebrow: { ...theme.text.eyebrow, color: theme.colors.textOnNavyMuted, marginBottom: 6 },
  heroMarqueeRouteRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, marginBottom: 4 },
  heroRoutePill: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  heroRoutePillText: { ...theme.text.badge, color: theme.colors.navy, fontVariant: ["tabular-nums" as const] },
  heroMarqueeHeadsign: { ...theme.text.subhead, color: theme.colors.textOnNavy, flexShrink: 1 },
  heroMarqueeStopRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  heroMarqueeStop: { ...theme.text.caption, color: theme.colors.textOnNavyMuted, flexShrink: 1, fontVariant: ["tabular-nums" as const] },
  heroProgressTrack: {
    height: 3,
    borderRadius: theme.radius.pill,
    backgroundColor: "rgba(255,255,255,0.18)",
    marginTop: 10,
    overflow: "hidden",
  },
  heroProgressFill: {
    height: 3,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.orangeBright,
  },
  heroMarqueeCountdown: {
    ...theme.text.display,
    fontSize: 30,
    lineHeight: 34,
    color: theme.colors.textOnNavy,
  },
  heroMarqueeSkeleton: { marginTop: 8 },

  // Search card — first card under the hero. NO negative top margin: the
  // CollapsingHeader paints the hero absolutely OVER the scroll view and pads
  // the content by maxHeight, so a negative margin would slide this card UNDER
  // the hero and slice its "Where to?" eyebrow. The header's padding owns the
  // spacing.
  searchCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    marginHorizontal: 16,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: 16,
    paddingBottom: 16,
    marginBottom: 0,
    ...theme.shadows.lg,
  },
  searchLabel: { ...theme.text.eyebrow, color: theme.colors.textMuted, marginBottom: 10 },
  searchInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.lg,
    height: 52,
    paddingHorizontal: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
  },
  searchInput: {
    flex: 1,
    fontFamily: "DMSans_400Regular",
    fontSize: 15,
    color: theme.colors.text,
  },
  searchBtn: {
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    ...theme.shadows.glowOrange,
  },
  searchBtnGradient: { paddingVertical: 13, alignItems: "center", justifyContent: "center" },
  searchBtnDisabled: { opacity: 0.6 },
  searchBtnText: { color: "#fff", fontFamily: "DMSans_600SemiBold", fontSize: 16, letterSpacing: 0.2 },
  searchError: { color: theme.colors.error, fontFamily: "DMSans_400Regular", fontSize: 13, marginTop: 8 },

  // Schedule section divider (separates search results from class block)
  scheduleSectionDivider: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 20,
    marginTop: 28,
    marginBottom: 20,
    gap: 10,
  },
  scheduleSectionLine: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  scheduleSectionLabel: { ...theme.text.eyebrow, color: theme.colors.textMuted },

  // Next up card
  nextUpLabelRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  nextUpCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    marginHorizontal: 16,
    marginTop: 0,
    marginBottom: 0,
    padding: 18,
    ...theme.shadows.md,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.orange,
  },
  nextUpLabel: { ...theme.text.eyebrow, color: theme.colors.brandInk },
  nextUpBodyRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  nextUpClassInfo: { flex: 1 },
  nextUpText: { fontFamily: "DMSans_700Bold", fontSize: 18, color: theme.colors.navy },
  nextUpTime: { fontFamily: "DMSans_500Medium", fontSize: 14, color: theme.colors.textSecondary, marginTop: 2 },
  walkingToClassBtn: { marginTop: 10, alignSelf: "flex-start" },
  walkingToClassBtnText: { fontFamily: "DMSans_600SemiBold", fontSize: 13, color: theme.colors.brandInk },
  nextUpWalkBadge: {
    backgroundColor: theme.colors.orangeSoft,
    borderRadius: theme.radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 64,
  },
  nextUpWalkBadgeNum: { fontFamily: "DMSans_700Bold", fontSize: 24, color: theme.colors.brandInk, lineHeight: 26, fontVariant: ["tabular-nums" as const] },
  nextUpWalkBadgeUnit: { fontFamily: "DMSans_400Regular", fontSize: 10, color: theme.colors.textMuted, textAlign: "center" as const, lineHeight: 13, marginTop: 2 },

  // Recommendations section
  recommendationsSection: { marginBottom: 0 },
  sectionTitle: { fontFamily: "DMSerifDisplay_400Regular", fontSize: 20, color: theme.colors.navy, marginBottom: 2, paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg },
  sectionSubtitle: { fontFamily: "DMSans_400Regular", fontSize: 13, color: theme.colors.textMuted, paddingHorizontal: theme.spacing.lg, marginBottom: 6 },
  getThereHeader: { paddingHorizontal: theme.spacing.lg, paddingTop: 32, paddingBottom: 2 },
  getThereTitle: { fontFamily: "DMSerifDisplay_400Regular", fontSize: 22, color: theme.colors.navy, marginBottom: 2 },

  // Option card — transit board redesign
  optionCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    marginHorizontal: theme.layout.gutter,
    marginBottom: 10,
    marginTop: 0,
    borderLeftWidth: 5,
    borderLeftColor: theme.colors.orange,
    padding: theme.layout.gutter,
    ...theme.elevation[2],
  },
  // `Press variant="lift"` owns shadowOpacity/Radius/elevation while the card
  // is a press surface, so the highlight can no longer be a glow alone — the
  // ring is what actually survives (and is the more legible signal anyway).
  optionCardHighlight: {
    ...theme.shadows.glowOrange,
    shadowOpacity: 0.25,
    borderWidth: 1,
    borderColor: theme.colors.orange,
  },

  // Card main row layout: info left | countdown right
  cardMainRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 12 },
  cardLeftCol: { flex: 1, marginRight: 12 },
  cardCountdownCol: { alignItems: "flex-end", justifyContent: "flex-start", minWidth: 64 },
  cardBadgeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },

  cardTypeBadge: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  cardTypeBadgeWalk: { backgroundColor: theme.colors.navyLight },
  cardTypeBadgeBus: { backgroundColor: theme.colors.navy },
  cardTypeBadgeText: { fontFamily: "DMSans_700Bold", fontSize: 10, color: "#fff", letterSpacing: 0.8 },

  // Hero countdown — brandInk keeps the big numeral AA on white
  cardDepartTime: { fontFamily: "DMSans_700Bold", fontSize: 44, color: theme.colors.brandInk, lineHeight: 48, letterSpacing: -1, fontVariant: ["tabular-nums" as const] },
  cardDepartNow: { fontFamily: "DMSans_700Bold", fontSize: 28, color: theme.colors.successDeep, lineHeight: 32, fontVariant: ["tabular-nums" as const] },
  cardDepartUnit: { fontFamily: "DMSans_500Medium", fontSize: 11, color: theme.colors.textMuted, textAlign: "right" as const, marginTop: 1 },

  // Step flow
  stepFlowText: { fontFamily: "DMSans_400Regular", fontSize: 13, color: theme.colors.textSecondary, marginBottom: 6, lineHeight: 19, fontVariant: ["tabular-nums" as const] },

  // Walking-minutes badge
  walkBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  walkBadgeText: { ...theme.text.badge, fontSize: 10, color: theme.colors.textSecondary, fontVariant: ["tabular-nums" as const] },

  // AI explanation — clamped quote
  aiQuoteWrap: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.orangeSoft,
    paddingLeft: theme.spacing.md,
    marginBottom: 10,
  },
  aiExplanation: { fontFamily: "DMSans_400Regular", fontSize: 12, lineHeight: 17, color: theme.colors.brandInk, fontStyle: "italic" },

  // Card footer row
  cardBottomRow: { flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: theme.colors.borderSoft, paddingTop: 8 },
  cardTotalTime: { fontFamily: "DMSans_400Regular", fontSize: 12, color: theme.colors.textMuted, fontVariant: ["tabular-nums" as const] },
  startBtnInline: {
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    ...theme.shadows.glowOrange,
  },
  startBtnInlineGradient: { minHeight: theme.layout.tapMin, minWidth: theme.layout.tapMin, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  // Beacon halo sits behind the CTA. Absolute with no insets, so Yoga centers
  // it on the container's align/justify without reserving any layout space.
  startBtnBeaconWrap: { alignItems: "center", justifyContent: "center" },
  startBtnBeacon: { position: "absolute" },
  startBtnInlineText: { fontFamily: "DMSans_700Bold", fontSize: 14, color: "#fff" },

  // MTD hint
  mtdHint: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.warning,
  },
  mtdHintText: { fontSize: 13, color: theme.colors.textSecondary },

  // Stops section — departure board aesthetic
  stopsSectionTitle: { ...theme.text.eyebrow, color: theme.colors.textMuted, marginBottom: 0, paddingHorizontal: theme.spacing.lg, paddingTop: 20, paddingBottom: 10 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    marginHorizontal: theme.layout.gutter,
    marginBottom: 10,
    overflow: "hidden",
    ...theme.elevation[2],
  },
  stopCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingHorizontal: 14, paddingTop: 11, paddingBottom: 9 },
  stopName: { fontFamily: "DMSans_700Bold", fontSize: 14, color: "#fff", flex: 1 },
  favoriteStopBtn: { minWidth: theme.layout.tapMin, minHeight: 36, alignItems: "center", justifyContent: "center" },
  distance: { fontFamily: "DMSans_400Regular", fontSize: 11, color: theme.colors.textOnNavyMuted, marginTop: 0, fontVariant: ["tabular-nums" as const] },
  departures: { paddingVertical: 4 },
  depExtrasRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: theme.spacing.lg, paddingBottom: 6 },
  depText: { fontFamily: "DMSans_400Regular", fontSize: 13, color: theme.colors.textMuted, padding: 14 },
  depSkeletonWrap: { padding: 14, gap: 8 },

  // Error / permission screens
  errorText: { fontFamily: "DMSans_600SemiBold", fontSize: 17, color: theme.colors.error },
  hint: { fontFamily: "DMSans_400Regular", fontSize: 14, color: theme.colors.textSecondary, marginTop: 8, textAlign: "center" },
  retryBtn: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: theme.colors.navy,
    borderRadius: theme.radius.md,
  },
  retryBtnText: { fontFamily: "DMSans_600SemiBold", color: "#fff", fontSize: 15 },
  retryBtnSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.colors.navy, marginTop: 8 },
  retryBtnSecondaryText: { fontFamily: "DMSans_600SemiBold", color: theme.colors.navy, fontSize: 15 },

  // Banners — floating rounded cards
  rainBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.colors.navyLight,
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.md,
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: theme.radius.lg,
    ...theme.shadows.sm,
  },
  rainBannerText: { fontFamily: "DMSans_400Regular", fontSize: 13, color: "rgba(255,255,255,0.9)", flex: 1 },
  rainBannerIcon: { fontSize: 18, color: "#fff", paddingLeft: 8 },

  uiucBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: theme.radius.lg,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.navy,
    ...theme.shadows.sm,
  },
  uiucBannerText: { fontFamily: "DMSans_400Regular", fontSize: 13, color: theme.colors.textSecondary, flex: 1 },
  uiucBannerLink: { fontFamily: "DMSans_600SemiBold", fontSize: 13, color: theme.colors.brandInk },
  offlineBanner: {
    backgroundColor: theme.colors.navy,
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.md,
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: theme.radius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    ...theme.shadows.sm,
  },
  offlineBannerText: { fontFamily: "DMSans_400Regular", fontSize: 13, color: "#fff", flex: 1 },
  offlineBannerRetry: { fontFamily: "DMSans_600SemiBold", fontSize: 13, color: theme.colors.orangeBright, paddingLeft: 8 },

  // Leave Now banner — ctaEnd ground keeps white copy AA
  leaveNowBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.ctaEnd,
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.lg,
    marginBottom: 0,
  },
  leaveNowLeft: { flex: 1, marginRight: theme.spacing.sm },
  leaveNowTitle: { fontFamily: "DMSans_600SemiBold", fontSize: 15, color: "#fff", marginBottom: 2 },
  // Pure white — the 0.88 alpha measured 4.31:1 on the orange ctaEnd ground.
  leaveNowBody: { fontFamily: "DMSans_400Regular", fontSize: 13, color: "#fff", fontVariant: ["tabular-nums" as const] },
  leaveNowStartBtn: {
    backgroundColor: "#fff",
    borderRadius: theme.radius.md,
    minHeight: theme.layout.tapMin,
    minWidth: theme.layout.tapMin,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  leaveNowStartBtnText: { fontFamily: "DMSans_700Bold", fontSize: 14, color: theme.colors.brandInk },
  leaveNowDismiss: { padding: 8, minWidth: 36, minHeight: 36, alignItems: "center", justifyContent: "center" },

  // Leave By smart card — navy gradient
  leaveByCard: {
    borderRadius: theme.radius.xl,
    marginHorizontal: 16,
    marginVertical: 10,
    padding: 16,
    ...theme.shadows.glowNavy,
  },
  leaveByHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  leaveByTitle: { fontSize: 15, fontFamily: "DMSans_600SemiBold", color: "#fff", flex: 1 },
  leaveByTime: { fontSize: 13, fontFamily: "DMSans_500Medium", color: theme.colors.textOnNavyMuted, fontVariant: ["tabular-nums" as const] },
  leaveByRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  leaveByStatusPill: { borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2 },
  leaveByStatusText: { fontSize: 10, fontFamily: "DMSans_700Bold", color: "#fff" },
  leaveByRouteText: { fontSize: 13, fontFamily: "DMSans_600SemiBold", color: "#fff" },
  leaveBySummary: { fontSize: 13, fontFamily: "DMSans_400Regular", color: theme.colors.textOnNavyMuted, flex: 1, fontVariant: ["tabular-nums" as const] },
  // Gold, not orangeBright — orange on the navy card measured 3.81:1.
  leaveByWalkFallback: { fontSize: 13, fontFamily: "DMSans_400Regular", color: theme.colors.gold, marginTop: 6, fontVariant: ["tabular-nums" as const] },

  // Autocomplete
  suggestionsList: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    marginBottom: 8,
    overflow: "hidden",
    ...theme.shadows.sm,
  },
  suggestionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  suggestionRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  suggestionIconWrap: { width: 22, alignItems: "center" },
  suggestionText: { fontFamily: "DMSans_400Regular", fontSize: 14, color: theme.colors.text, flex: 1 },
  suggestionType: { fontFamily: "DMSans_600SemiBold", fontSize: 10, color: theme.colors.navy, backgroundColor: theme.colors.surfaceAlt, paddingHorizontal: 5, paddingVertical: 1, borderRadius: theme.radius.xs, marginLeft: 6 },
  suggestionSub: { fontFamily: "DMSans_400Regular", fontSize: 12, color: theme.colors.textMuted, marginTop: 1, paddingBottom: 2, marginLeft: 30 },

  // Recent searches — pill chips
  recentSearches: { marginTop: 8 },
  recentLabel: { ...theme.text.eyebrow, color: theme.colors.textMuted },
  recentChipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  recentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: 220,
  },
  recentChipText: { fontFamily: "DMSans_500Medium", fontSize: 13, color: theme.colors.navy, flexShrink: 1 },

  // In-flight search skeleton cards
  searchSkeletonWrap: { marginHorizontal: theme.layout.gutter, marginTop: theme.layout.cardGap, gap: theme.layout.cardGap },

  // Search results header
  searchResultsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg, marginBottom: 4 },
  saveFavBtn: { fontFamily: "DMSans_600SemiBold", fontSize: 13, color: theme.colors.brandInk, paddingTop: 2 },

  // Plan evening
  planEveningBtn: { marginTop: 8, alignSelf: "flex-start" },
  planEveningBtnText: { fontFamily: "DMSans_600SemiBold", fontSize: 13, color: theme.colors.brandInk },

  // Recommendations unavailable
  recommendationsUnavailable: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    padding: 12,
    marginHorizontal: theme.spacing.lg,
    marginVertical: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  recommendationsUnavailableText: { fontFamily: "DMSans_400Regular", fontSize: 14, color: theme.colors.textSecondary },
  recSkeletonWrap: { marginHorizontal: theme.layout.gutter, marginVertical: theme.layout.cardGap, gap: theme.layout.cardGap },

  // Option meta (kept for compatibility, not used in new card layout)
  optionMeta: { fontFamily: "DMSans_400Regular", fontSize: 13, color: theme.colors.textSecondary, marginTop: 4 },
  optionCardTitle: { fontFamily: "DMSans_600SemiBold", fontSize: 15, color: theme.colors.navy },

  // Card actions row (share + start)
  cardActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  shareBtn: {
    minHeight: theme.layout.tapMin,
    minWidth: theme.layout.tapMin,
    paddingHorizontal: 12,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  shareBtnText: { fontFamily: "DMSans_600SemiBold", fontSize: 13, color: theme.colors.textSecondary },

  // Quick chips row (home + pinned)
  quickChipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  homePlaceChip: {
    backgroundColor: theme.colors.navy,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 16,
    minHeight: theme.layout.tapMin,
    justifyContent: "center",
    ...theme.shadows.glowNavy,
  },
  homePlaceChipText: { fontFamily: "DMSans_600SemiBold", fontSize: 14, color: "#fff" },
  pinnedChip: {
    backgroundColor: theme.colors.orangeSoft,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 14,
    minHeight: theme.layout.tapMin,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(232,74,39,0.25)",
  },
  pinnedChipText: { fontFamily: "DMSans_500Medium", fontSize: 14, color: theme.colors.brandInk },

  // Search result action buttons
  searchResultActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  pinBtn: { fontFamily: "DMSans_600SemiBold", fontSize: 13, color: theme.colors.textSecondary },

  // Suggestion save button (star)
  suggestionMain: { flex: 1, minHeight: theme.layout.tapMin, justifyContent: "center", paddingVertical: 8 },
  suggestionSaveBtn: { minWidth: theme.layout.tapMin, minHeight: theme.layout.tapMin, alignItems: "center", justifyContent: "center" },

  // F2: Sort pills
  sortRow: { flexDirection: 'row', gap: 6, marginBottom: 12, flexWrap: 'wrap', marginTop: 8 },
  sortPill: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  sortPillActive: { backgroundColor: theme.colors.navy, borderColor: theme.colors.navy },
  sortPillText: { fontSize: 12, fontFamily: "DMSans_500Medium", color: theme.colors.textSecondary },
  sortPillTextActive: { color: '#fff' },

  // F2: Status pill on option cards — always text, deep AA fills
  optionStatusPill: { borderRadius: theme.radius.xs, paddingHorizontal: 6, paddingVertical: 2 },
  optionStatusText: { fontSize: 10, fontFamily: "DMSans_700Bold", color: '#fff', letterSpacing: 0.4, fontVariant: ["tabular-nums" as const] },

  // F2: MTD free caption
  mtdFree: { fontSize: 11, fontFamily: "DMSans_400Regular", color: theme.colors.textMuted, marginTop: 2 },

  // F2: Smart callouts
  smartCallout: { fontSize: 13, fontFamily: "DMSans_400Regular", fontStyle: 'italic', color: theme.colors.brandInk, marginTop: 6, paddingHorizontal: theme.spacing.lg, fontVariant: ["tabular-nums" as const] },
  smartCalloutGreen: { color: theme.colors.successDeep },

  // F3: Running late pill trigger — errorDeep keeps the white label AA
  runningLatePill: {
    alignSelf: 'flex-start',
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    backgroundColor: theme.colors.errorDeep,
    borderRadius: theme.radius.pill,
    minHeight: theme.layout.tapMin,
    justifyContent: 'center',
    paddingHorizontal: 16,
    shadowColor: theme.colors.error,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  runningLatePillText: { fontFamily: "DMSans_700Bold", fontSize: 13, color: '#fff', letterSpacing: 0.3 },

  // Stale departure badge — warning glyph + label on a soft AA-safe tint
  staleBadge: { backgroundColor: theme.colors.warningSoft, borderRadius: theme.radius.xs, paddingHorizontal: 6, paddingVertical: 2 },
  staleBadgeText: { fontFamily: 'DMSans_600SemiBold', fontSize: 10, color: theme.colors.warningDeep },

  // Recent searches header row
  recentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  recentClearBtn: { fontSize: 12, fontFamily: 'DMSans_400Regular', color: theme.colors.textMuted },
});
