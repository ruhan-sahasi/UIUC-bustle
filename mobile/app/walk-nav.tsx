import React from "react";
import { createShareTrip, fetchBusRouteStops, fetchVehicles, fetchWalkingRoute, patchShareTrip } from "@/src/api/client";
import type { BusStop, VehicleInfo } from "@/src/api/client";
import type { ShareTripRequest } from "@/src/api/types";
import { getMpsForMode, WALKING_MODES } from "@/src/constants/walkingMode";
import type { WalkingModeId } from "@/src/constants/walkingMode";
import { useAnalytics } from "@/src/hooks/useAnalytics";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { useRecommendationSettings } from "@/src/hooks/useRecommendationSettings";
import { addActivityEntry, todayDateString } from "@/src/storage/activityLog";
import { MET_BY_MODE, calcCalories } from "@/src/utils/activity";
import { formatDistance, haversineMeters } from "@/src/utils/distance";
import * as Location from "expo-location";
import { Pedometer } from "expo-sensors";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AlertTriangle, Bus, Check, Flame, Footprints, MapPin, PartyPopper, Share2, Timer, X } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, { Callout, Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { theme } from "@/src/constants/theme";
import { SPRING, TIMING } from "@/src/constants/motion";
import { Button } from "@/src/components/ui/Button";
import {
  CelebrationBurst,
  FadeInView,
  fireHaptic,
  Odometer,
  PressableScale,
  ProgressRing,
  Stagger,
  TickingCountdown,
  useGlide,
} from "@/src/components/ui/motion";
import { getEntranceCoords } from "@/src/utils/buildingEntrance";

const ARRIVAL_THRESHOLD_M = 30;
const OFF_ROUTE_THRESHOLD_M = 120;
// Throttle between walking-route retries after a failed OSRM fetch
const WALK_ROUTE_RETRY_MS = 15_000;

/** Minimum distance (meters) from point (pLat, pLng) to a line segment [(aLat,aLng)-(bLat,bLng)] */
function distToSegmentM(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number
): number {
  const dx = bLng - aLng, dy = bLat - aLat;
  if (dx === 0 && dy === 0) return haversineMeters(pLat, pLng, aLat, aLng);
  const t = Math.max(0, Math.min(1, ((pLng - aLng) * dx + (pLat - aLat) * dy) / (dx * dx + dy * dy)));
  return haversineMeters(pLat, pLng, aLat + t * dy, aLng + t * dx);
}

function minDistToPolylineM(lat: number, lng: number, coords: { latitude: number; longitude: number }[]): number {
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) return haversineMeters(lat, lng, coords[0].latitude, coords[0].longitude);
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distToSegmentM(lat, lng, coords[i].latitude, coords[i].longitude, coords[i + 1].latitude, coords[i + 1].longitude);
    if (d < min) min = d;
  }
  return min;
}

/** m:ss display for the elapsed-time readout (tabular styles keep it steady). */
function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Small icon + value pair on the dark HUD. */
function HudStat({ icon: Icon, value, a11yLabel }: { icon: LucideIcon; value: string; a11yLabel: string }) {
  return (
    <View style={styles.hudStat} accessible accessibilityLabel={a11yLabel}>
      <Icon size={13} color={theme.colors.textOnNavyMuted} strokeWidth={2.2} />
      <Text style={styles.hudStatValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

/** Arrival-modal stat tile: icon, tabular value, eyebrow label. */
function StatTile({ icon: Icon, value, label }: { icon: LucideIcon; value: string; label: string }) {
  return (
    <View style={styles.statTile} accessible accessibilityLabel={`${label}: ${value}`}>
      <Icon size={16} color={theme.colors.brandInk} strokeWidth={2.2} />
      <Text style={styles.statTileValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.statTileLabel}>{label}</Text>
    </View>
  );
}

// ── HUD primary readout ───────────────────────────────────────────────────

/** Column count for a non-negative integer, minimum one. */
function digitPlaces(n: number): number {
  return String(Math.max(0, Math.floor(n))).length;
}

/**
 * `formatDistance()` output split into odometer parts.
 *
 * Deliberately parses that helper's own string rather than re-deriving feet
 * and miles: the rolling digits and the spoken label are then the same number
 * by construction, so a rounding difference can never make the HUD say one
 * thing and VoiceOver another.
 */
function splitDistance(meters: number): { whole: number; tenths: number | null; unit: string; label: string } {
  const label = formatDistance(meters);
  const [num, unit] = label.split(" ");
  const [w, t] = num.split(".");
  const whole = parseInt(w, 10);
  return {
    whole: Number.isFinite(whole) ? whole : 0,
    tenths: t != null ? parseInt(t, 10) : null,
    unit: unit ?? "",
    label,
  };
}

/**
 * A big HUD number as rolling odometer columns plus a quiet unit suffix.
 *
 * The odometers carry their own (stable) labels, but every caller wraps this in
 * an `accessible` HudPrimaryCell, so the cell speaks once and the individual
 * digit columns stay out of the VoiceOver order.
 */
function HudRollingValue({
  whole,
  tenths,
  unit,
  a11yLabel,
}: { whole: number; tenths: number | null; unit: string; a11yLabel: string }) {
  return (
    <View style={styles.hudValueRow}>
      <Odometer
        value={whole}
        places={digitPlaces(whole)}
        padWithZeros={false}
        style={styles.hudPrimaryValue}
        accessibilityLabel={a11yLabel}
      />
      {tenths != null && (
        <React.Fragment>
          <Text style={styles.hudPrimaryValue}>.</Text>
          <Odometer
            value={tenths}
            places={1}
            style={styles.hudPrimaryValue}
            accessibilityLabel={a11yLabel}
          />
        </React.Fragment>
      )}
      {unit.length > 0 && <Text style={styles.hudPrimaryUnit}>{unit}</Text>}
    </View>
  );
}

/** Elapsed m:ss as rolling columns. Seconds roll fast so the tick reads as live. */
function HudElapsedValue({ totalSeconds }: { totalSeconds: number }) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return (
    <View style={styles.hudValueRow}>
      <Odometer
        value={m}
        places={digitPlaces(m)}
        padWithZeros={false}
        style={styles.hudPrimaryValue}
        accessibilityLabel="Elapsed minutes"
      />
      <Text style={styles.hudPrimaryValue}>:</Text>
      <Odometer
        value={s}
        places={2}
        duration={TIMING.fast.duration}
        style={styles.hudPrimaryValue}
        accessibilityLabel="Elapsed seconds"
      />
    </View>
  );
}

/**
 * One cell of the primary HUD row. `accessible` on the cell is what keeps the
 * live digits from being announced individually: the cell speaks a single
 * whole-unit label that only changes when the whole unit changes.
 */
function HudPrimaryCell({
  label,
  a11yLabel,
  children,
}: { label: string; a11yLabel: string; children: React.ReactNode }) {
  return (
    <View style={styles.hudPrimaryCell} accessible accessibilityLabel={a11yLabel}>
      <Text style={styles.hudPrimaryLabel}>{label}</Text>
      {children}
    </View>
  );
}

// ── Pace chip ─────────────────────────────────────────────────────────────

type PaceStatus = "on-track" | "behind" | "ahead";

/**
 * Pace chip whose fill glides mint -> amber as the margin against class time
 * shrinks.
 *
 * The colour is a second channel, never the only one: the icon and the full
 * sentence carry the status on their own, and the fill stays light enough that
 * navy ink on it clears AA at both ends of the ramp (white ink would not).
 */
function PaceChip({ status, marginMins }: { status: PaceStatus; marginMins: number }) {
  // +3 min of slack reads fully mint, -1 min reads fully amber — the same two
  // thresholds the already-computed paceStatus uses, so colour and word agree.
  const t = Math.min(Math.max((3 - marginMins) / 4, 0), 1);
  const glide = useGlide(t, { timing: TIMING.base });
  const fill = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(glide.value, [0, 1], [theme.colors.mint, theme.colors.gold]),
  }));

  const lateMins = Math.abs(Math.round(marginMins));
  const text =
    status === "behind"
      ? `Behind pace — ${lateMins} min late at this speed`
      : status === "ahead"
        ? "On track — arriving early"
        : "On pace for class";
  const Icon = status === "behind" ? AlertTriangle : Check;
  // Spoken separately from the printed sentence: screen readers say the
  // abbreviation "min" as-is, and the em dash reads as nothing at all.
  const a11yText =
    status === "behind"
      ? `Behind pace, ${lateMins} ${lateMins === 1 ? "minute" : "minutes"} late at this speed`
      : status === "ahead"
        ? "On track, arriving early"
        : "On pace for class";

  return (
    <Animated.View style={[styles.paceChip, fill]} accessible accessibilityLabel={a11yText}>
      <Icon size={13} color={theme.colors.navyDeep} strokeWidth={2.6} />
      <Text style={styles.paceChipText}>{text}</Text>
    </Animated.View>
  );
}

// ── Arrival card ──────────────────────────────────────────────────────────

interface ArrivalCardProps {
  destName: string;
  distanceLabel: string;
  durationLabel: string;
  energyLabel: string;
  stepsLabel: string | null;
  encouragement: string | null;
  onFinish: () => void;
}

/**
 * The arrival moment: the ring closes to 100%, the success haptic fires, the
 * burst goes off and the stat tiles rise in.
 *
 * This is the ONE place in the app allowed to use SPRING.joy — the card's
 * entrance overshoots on purpose. Everything here is render-only; the trip is
 * already recorded by the time this mounts.
 */
function ArrivalCard({
  destName,
  distanceLabel,
  durationLabel,
  energyLabel,
  stepsLabel,
  encouragement,
  onFinish,
}: ArrivalCardProps) {
  const scale = useSharedValue(0.92);
  useEffect(() => {
    fireHaptic("arrive");
    scale.value = withSpring(1, SPRING.joy);
  }, [scale]);
  const cardStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[styles.modalCard, cardStyle]}>
      <View style={styles.ringWrap}>
        <ProgressRing progress={1} size={96} strokeWidth={8} colors={theme.gradients.sunset}>
          <View style={styles.modalHalo}>
            <PartyPopper size={30} color={theme.colors.brandInk} strokeWidth={1.8} />
          </View>
        </ProgressRing>
      </View>
      <Text style={styles.modalEyebrow}>Trip complete</Text>
      <Text style={styles.modalTitle} accessibilityRole="header">You arrived!</Text>
      <Text style={styles.modalDest} numberOfLines={2}>{destName}</Text>
      <Stagger style={styles.statGrid} itemStyle={styles.statTileWrap}>
        <StatTile icon={MapPin} value={distanceLabel} label="Distance" />
        <StatTile icon={Timer} value={durationLabel} label="Duration" />
        <StatTile icon={Flame} value={energyLabel} label="Energy" />
        {stepsLabel != null && <StatTile icon={Footprints} value={stepsLabel} label="Steps" />}
      </Stagger>
      {encouragement && (
        <Text style={styles.encouragementText}>{encouragement}</Text>
      )}
      <View style={styles.modalCtaWrap}>
        <Button label="Save & finish" onPress={onFinish} />
      </View>
      <View pointerEvents="none" style={styles.burstLayer}>
        <CelebrationBurst count={22} radius={130} />
      </View>
    </Animated.View>
  );
}

type NavPhase = "walking" | "bus";

export default function WalkNavScreen() {
  const router = useRouter();
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const { capture } = useAnalytics();
  const { weightKg } = useRecommendationSettings();
  const params = useLocalSearchParams<{
    dest_lat: string;
    dest_lng: string;
    dest_name: string;
    walking_mode_id: string;
    route_id: string;
    stop_id: string;
    alighting_stop_id: string;
    alighting_lat: string;
    alighting_lng: string;
    building_id: string;
    arrive_by_class_time: string;
    bus_dep_epoch_ms: string;
    final_lat: string;
    final_lng: string;
    final_name: string;
  }>();

  const buildingId = params.building_id ?? "";
  const entranceOverride = buildingId ? getEntranceCoords(buildingId) : null;
  const destLat = entranceOverride ? entranceOverride.lat : parseFloat(params.dest_lat ?? "");
  const destLng = entranceOverride ? entranceOverride.lng : parseFloat(params.dest_lng ?? "");
  const destName = params.dest_name ?? "Destination";
  const finalDestLat = parseFloat(params.final_lat ?? "");
  const finalDestLng = parseFloat(params.final_lng ?? "");
  const finalDestName = params.final_name ?? destName;
  const hasFinalDest = !isNaN(finalDestLat) && !isNaN(finalDestLng);
  const modeId = (params.walking_mode_id ?? "walk") as WalkingModeId;
  const routeId = params.route_id ?? "";
  const boardingStopId = params.stop_id ?? "";
  const alightingStopId = params.alighting_stop_id ?? "";
  const alightingLat = parseFloat(params.alighting_lat ?? "");
  const alightingLng = parseFloat(params.alighting_lng ?? "");
  // Bus mode: we have a route and an alighting stop
  const isBusMode = routeId.length > 0 && alightingStopId.length > 0 && !isNaN(alightingLat) && !isNaN(alightingLng);

  const modeLabel = WALKING_MODES.find((m) => m.id === modeId)?.label ?? "Walk";
  const speedMps = getMpsForMode(modeId);

  const [navPhase, setNavPhase] = useState<NavPhase>("walking");
  const [walkingRouteCoords, setWalkingRouteCoords] = useState<{ latitude: number; longitude: number }[]>([]);
  const [busStops, setBusStops] = useState<BusStop[]>([]);
  const [busShapeCoords, setBusShapeCoords] = useState<{ latitude: number; longitude: number }[]>([]);
  const [walkFromBusCoords, setWalkFromBusCoords] = useState<{ latitude: number; longitude: number }[]>([]);
  const [alightingStopName, setAlightingStopName] = useState<string>("");

  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [distanceM, setDistanceM] = useState<number | null>(null);
  const [stepCount, setStepCount] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [caloriesBurned, setCaloriesBurned] = useState(0);
  const [arrived, setArrived] = useState(false);
  const [showCompletion, setShowCompletion] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [pedometerAvailable, setPedometerAvailable] = useState(false);
  const [encouragement, setEncouragement] = useState<string | null>(null);
  const [busVehicles, setBusVehicles] = useState<VehicleInfo[]>([]);
  const [entranceDesc] = useState<string | null>(entranceOverride?.desc ?? null);
  const [busDepEpochMs] = useState<number | null>(
    params.bus_dep_epoch_ms ? parseInt(params.bus_dep_epoch_ms, 10) : null
  );
  const [busMissed, setBusMissed] = useState(false);

  const startTimeRef = useRef<number>(Date.now());
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const pedometerSubRef = useRef<{ remove: () => void } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vehiclePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const arrivedRef = useRef(false);
  const shareTokenRef = useRef<string | null>(null);
  // Writer credential from createShareTrip — required by the backend on PATCH,
  // never part of the shared URL.
  const shareEditTokenRef = useRef<string | null>(null);
  const walkedDistanceMRef = useRef(0);
  const lastPositionRef = useRef<{ lat: number; lng: number } | null>(null);
  const walkingRouteFetchedRef = useRef(false);
  const walkingRouteRetryAtRef = useRef(0);
  const navPhaseRef = useRef<NavPhase>("walking");
  const busMissedRef = useRef(false);
  const busMissedDismissedRef = useRef(false);
  const shareToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track current target for arrival detection
  const currentTargetRef = useRef<{ lat: number; lng: number }>({ lat: destLat, lng: destLng });

  const [shareErrorToast, setShareErrorToast] = useState<string | null>(null);

  const [zoomDelta, setZoomDelta] = useState(0.005);
  const zoomIn = () => setZoomDelta((d) => Math.max(d / 2, 0.0003));
  const zoomOut = () => setZoomDelta((d) => Math.min(d * 2, 0.5));

  const handleWalkNavShare = useCallback(async () => {
    const etaEpoch = distanceM !== null ? Math.floor(Date.now() / 1000) + Math.floor(distanceM / speedMps) : undefined;
    const body: ShareTripRequest = {
      destination: hasFinalDest ? finalDestName : destName,
      route_id: routeId || null,
      route_name: null,
      stop_name: null,
      phase: navPhaseRef.current === "bus" ? "on_bus" : "walking",
      eta_epoch: etaEpoch,
    };
    try {
      const result = await createShareTrip(apiBaseUrl, body, { apiKey: apiKey ?? undefined });
      shareTokenRef.current = result.token;
      shareEditTokenRef.current = result.edit_token ?? null;
      const shareUrl = result.url ?? `${apiBaseUrl.replace(/\/$/, "")}/t/${result.token}`;
      const msg = `Heading to ${body.destination}${routeId ? ` · Bus ${routeId}` : ""}. ${shareUrl}`;
      await Share.share({ message: msg, url: shareUrl });
    } catch {
      setShareErrorToast("Couldn't reach share server — sharing directly");
      if (shareToastTimerRef.current) clearTimeout(shareToastTimerRef.current);
      shareToastTimerRef.current = setTimeout(() => setShareErrorToast(null), 2500);
      const msg = `Heading to ${body.destination}${routeId ? ` · Bus ${routeId}` : ""}`;
      await Share.share({ message: msg });
    }
  }, [apiBaseUrl, apiKey, destName, finalDestName, hasFinalDest, routeId, speedMps, distanceM]);

  const mapRef = useRef<MapView | null>(null);
  const walkingRouteCoordsRef = useRef<{ latitude: number; longitude: number }[]>([]);
  const offRouteRefetchRef = useRef(false);

  // Fire once on mount — intentional empty deps to fire exactly once regardless of re-renders
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    capture("walk_started", { walking_mode: modeId });
  }, []);

  useEffect(() => () => {
    if (shareToastTimerRef.current) clearTimeout(shareToastTimerRef.current);
  }, []);

  // Keep navPhaseRef in sync
  useEffect(() => {
    navPhaseRef.current = navPhase;
  }, [navPhase]);

  // Send on_bus PATCH when navPhase transitions to "bus" — separated from the
  // "waiting" PATCH (fired in the location callback) to avoid a request ordering race.
  useEffect(() => {
    if (navPhase === "bus" && shareTokenRef.current) {
      patchShareTrip(apiBaseUrl, shareTokenRef.current, { phase: "on_bus" }, { apiKey: apiKey ?? undefined, editToken: shareEditTokenRef.current });
    }
    if (navPhase === "bus") {
      capture("bus_phase_entered");
    }
  }, [navPhase, apiBaseUrl, apiKey, capture]);

  // Keep walkingRouteCoordsRef in sync
  useEffect(() => {
    walkingRouteCoordsRef.current = walkingRouteCoords;
  }, [walkingRouteCoords]);

  // Start timer
  useEffect(() => {
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setDurationSeconds(elapsed);
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Live bus vehicle poll
  useEffect(() => {
    if (!routeId) return;
    const poll = async () => {
      try {
        const res = await fetchVehicles(apiBaseUrl, routeId, { apiKey: apiKey ?? undefined });
        setBusVehicles(res.vehicles ?? []);
      } catch {}
    };
    poll();
    vehiclePollRef.current = setInterval(poll, 8_000);
    return () => {
      if (vehiclePollRef.current) clearInterval(vehiclePollRef.current);
    };
  }, [routeId, apiBaseUrl, apiKey]);

  // Pedometer
  useEffect(() => {
    let cancelled = false;
    let sub: { remove: () => void } | null = null;
    (async () => {
      const avail = await Pedometer.isAvailableAsync().catch(() => false);
      // The await can resolve after teardown, and subscribing then would leave the
      // subscription running with no reachable handle to remove it
      if (cancelled) return;
      setPedometerAvailable(avail);
      if (!avail) return;
      const started = Pedometer.watchStepCount((result) => {
        setStepCount(result.steps);
      });
      sub = started;
      pedometerSubRef.current = started;
    })();
    return () => {
      cancelled = true;
      sub?.remove();
      pedometerSubRef.current = null;
    };
  }, []);

  // Fetch walking route on first GPS fix or when off-route
  const fetchWalkRoute = useCallback(async (userLat: number, userLng: number, force = false) => {
    if (walkingRouteFetchedRef.current && !force) return;
    // A failed attempt clears the guard so a later fix can retry, throttled so the
    // 2 s location callback cannot hammer the routing server while it is down.
    if (!force && Date.now() < walkingRouteRetryAtRef.current) return;
    walkingRouteFetchedRef.current = true;
    // Snap origin to UIUC if GPS is far away (simulator default = San Francisco)
    const UIUC_LAT = 40.102, UIUC_LNG = -88.2272;
    const distToUiuc = Math.sqrt((userLat - UIUC_LAT) ** 2 + (userLng - UIUC_LNG) ** 2) * 111_000;
    const origLat = distToUiuc > 100_000 ? UIUC_LAT : userLat;
    const origLng = distToUiuc > 100_000 ? UIUC_LNG : userLng;
    try {
      const res = await fetchWalkingRoute(
        apiBaseUrl,
        origLat, origLng,
        destLat, destLng,
        { apiKey: apiKey ?? undefined }
      );
      if (res.coords.length > 1) {
        setWalkingRouteCoords(res.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng })));
      } else {
        walkingRouteFetchedRef.current = false;
        walkingRouteRetryAtRef.current = Date.now() + WALK_ROUTE_RETRY_MS;
      }
    } catch {
      walkingRouteFetchedRef.current = false;
      walkingRouteRetryAtRef.current = Date.now() + WALK_ROUTE_RETRY_MS;
    }
  }, [apiBaseUrl, apiKey, destLat, destLng]);

  // Fetch bus route shape + stops; used both at mount (preview) and on phase switch
  const fetchBusData = useCallback(async () => {
    if (!isBusMode || !boardingStopId || !alightingStopId) return;
    try {
      const now = new Date();
      const afterTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
      const res = await fetchBusRouteStops(
        apiBaseUrl,
        routeId,
        boardingStopId,
        alightingStopId,
        afterTime,
        { apiKey: apiKey ?? undefined }
      );
      if (res.stops.length > 0) {
        setBusStops(res.stops);
        const alightStop = res.stops.find((s) => s.stop_id === alightingStopId);
        if (alightStop) setAlightingStopName(alightStop.stop_name);
      }
      if (res.shape_points.length > 1) {
        setBusShapeCoords(res.shape_points.map(([lat, lng]) => ({ latitude: lat, longitude: lng })));
      } else {
        // GTFS shape unavailable — use OSRM road-following route as fallback
        const walk = await fetchWalkingRoute(
          apiBaseUrl, destLat, destLng, alightingLat, alightingLng,
          { apiKey: apiKey ?? undefined }
        );
        if (walk.coords.length > 1) {
          setBusShapeCoords(walk.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng })));
        }
      }

      // Dashed walk line from alighting stop to final destination
      if (hasFinalDest && alightingLat !== 0 && alightingLng !== 0) {
        try {
          const walkLeg = await fetchWalkingRoute(
            apiBaseUrl, alightingLat, alightingLng, finalDestLat, finalDestLng,
            { apiKey: apiKey ?? undefined }
          );
          setWalkFromBusCoords(
            walkLeg.coords.length > 1
              ? walkLeg.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))
              : [{ latitude: alightingLat, longitude: alightingLng }, { latitude: finalDestLat, longitude: finalDestLng }]
          );
        } catch {
          setWalkFromBusCoords([
            { latitude: alightingLat, longitude: alightingLng },
            { latitude: finalDestLat, longitude: finalDestLng },
          ]);
        }
      }
    } catch {}
  }, [apiBaseUrl, apiKey, routeId, boardingStopId, alightingStopId, isBusMode, destLat, destLng, alightingLat, alightingLng, hasFinalDest, finalDestLat, finalDestLng]);

  // Eagerly fetch bus shape at mount so it's visible during the walking phase
  useEffect(() => {
    if (isBusMode) fetchBusData();
  }, [isBusMode, fetchBusData]);

  // The location callback reads these through refs: apiBaseUrl, apiKey and weightKg all
  // resolve from AsyncStorage a tick after mount, and depending on them directly would
  // tear down and restart the GPS watch mid-walk.
  const fetchWalkRouteRef = useRef(fetchWalkRoute);
  const fetchBusDataRef = useRef(fetchBusData);
  const weightKgRef = useRef(weightKg);
  const apiRef = useRef({ apiBaseUrl, apiKey });
  useEffect(() => {
    fetchWalkRouteRef.current = fetchWalkRoute;
    fetchBusDataRef.current = fetchBusData;
    weightKgRef.current = weightKg;
    apiRef.current = { apiBaseUrl, apiKey };
  }, [fetchWalkRoute, fetchBusData, weightKg, apiBaseUrl, apiKey]);

  // Keep busMissedRef in sync
  useEffect(() => {
    busMissedRef.current = busMissed;
  }, [busMissed]);

  // Location tracking
  useEffect(() => {
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== "granted") {
          setLocationError("Location permission denied. Cannot track walk.");
          return;
        }
        const started = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 2000,
            distanceInterval: 5,
          },
          (loc) => {
            if (cancelled) return;
            let { latitude, longitude } = loc.coords;
            // Snap to UIUC if GPS is far away (simulator default = San Francisco)
            if (haversineMeters(latitude, longitude, 40.102, -88.2272) > 100_000) {
              latitude = 40.102;
              longitude = -88.2272;
            }
            setUserLocation({ lat: latitude, lng: longitude });

            // Fetch walking route on first fix
            fetchWalkRouteRef.current(latitude, longitude);

            const target = currentTargetRef.current;
            const dist = Math.round(haversineMeters(latitude, longitude, target.lat, target.lng));
            setDistanceM(dist);

            // Accumulate walked distance (ignore GPS jumps > 100 m)
            if (lastPositionRef.current) {
              const delta = haversineMeters(
                lastPositionRef.current.lat,
                lastPositionRef.current.lng,
                latitude,
                longitude
              );
              if (delta < 100) {
                walkedDistanceMRef.current += delta;
                const met = MET_BY_MODE[modeId] ?? 2.8;
                const walkedHours = walkedDistanceMRef.current / speedMps / 3600;
                setCaloriesBurned(calcCalories(met, weightKgRef.current, walkedHours));
              }
            }
            lastPositionRef.current = { lat: latitude, lng: longitude };

            // Missed bus detection
            if (
              busDepEpochMs &&
              navPhaseRef.current === "walking" &&
              Date.now() > busDepEpochMs + 30000 &&
              !busMissedRef.current &&
              !busMissedDismissedRef.current
            ) {
              busMissedRef.current = true;
              setBusMissed(true);
            }

            // Off-route detection: if >120m from polyline, re-fetch OSRM route
            if (
              navPhaseRef.current === "walking" &&
              !arrivedRef.current &&
              !offRouteRefetchRef.current &&
              walkingRouteCoordsRef.current.length > 1
            ) {
              const distToRoute = minDistToPolylineM(latitude, longitude, walkingRouteCoordsRef.current);
              if (distToRoute > OFF_ROUTE_THRESHOLD_M) {
                offRouteRefetchRef.current = true;
                walkingRouteFetchedRef.current = false;
                fetchWalkRouteRef.current(latitude, longitude, true).finally(() => {
                  offRouteRefetchRef.current = false;
                });
              }
            }

            // A degraded fix next to a building can sit tens of meters off the true
            // position, so widen the arrival radius with the fix's own accuracy estimate
            const reportedAccuracyM = loc.coords.accuracy != null && loc.coords.accuracy > 0 ? loc.coords.accuracy : 0;
            const arrivalThresholdM = Math.max(ARRIVAL_THRESHOLD_M, reportedAccuracyM * 1.5);

            if (dist <= arrivalThresholdM && !arrivedRef.current) {
              const phase = navPhaseRef.current;
              if (isBusMode && phase === "walking") {
                // Arrived at boarding stop — switch to bus phase
                arrivedRef.current = false; // reset so we can detect alighting stop arrival
                const { apiBaseUrl: base, apiKey: key } = apiRef.current;
                if (shareTokenRef.current) {
                  patchShareTrip(base, shareTokenRef.current, { phase: "waiting" }, { apiKey: key ?? undefined, editToken: shareEditTokenRef.current });
                }
                setNavPhase("bus");
                // on_bus PATCH is sent by a separate useEffect watching navPhase === "bus"
                currentTargetRef.current = { lat: alightingLat, lng: alightingLng };
                setDistanceM(null);
                fetchBusDataRef.current();
              } else {
                // Pure walk arrival OR arrived at alighting stop
                arrivedRef.current = true;
                setArrived(true);
              }
            }
          }
        );
        // The awaits above can resolve after teardown, which would strand the watch and
        // leave the GPS radio on for the lifetime of the process
        if (cancelled) {
          started.remove();
          return;
        }
        sub = started;
        locationSubRef.current = started;
      } catch {
        if (!cancelled) setLocationError("Couldn't start location tracking. Distance and ETA are unavailable.");
      }
    })();
    return () => {
      cancelled = true;
      sub?.remove();
      locationSubRef.current = null;
    };
  }, [destLat, destLng, isBusMode, alightingLat, alightingLng, modeId, speedMps, busDepEpochMs]);

  // Show completion modal on arrival + fetch encouragement
  useEffect(() => {
    if (arrived) {
      if (showCompletion) return; // already handled
      capture("trip_completed");
      if (timerRef.current) clearInterval(timerRef.current);
      if (shareTokenRef.current) {
        patchShareTrip(apiBaseUrl, shareTokenRef.current, { phase: "arrived" }, { apiKey: apiKey ?? undefined, editToken: shareEditTokenRef.current });
      }
      setShowCompletion(true);
      (async () => {
        try {
          const base = apiBaseUrl.replace(/\/$/, "");
          const res = await fetch(`${base}/ai/walk-complete`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { "X-API-Key": apiKey } : {}),
            },
            body: JSON.stringify({
              mode: modeId,
              distance_m: Math.round(walkedDistanceMRef.current),
              calories: caloriesBurned,
              dest_name: destName,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            setEncouragement(data.encouragement ?? null);
          }
        } catch {}
      })();
    }
  }, [arrived, showCompletion, capture, apiBaseUrl, apiKey, modeId, caloriesBurned, destName]);

  // Manual arrival takes the same path the GPS threshold crossing takes, so the trip is
  // still recorded when the fix is too coarse to ever cross it. In bus mode the walking leg
  // ends at the boarding stop, so tapping this during that leg must advance to the bus phase
  // exactly like the automatic branch does; ending the whole trip there would drop the bus
  // leg and write an activity entry for a trip that has not happened.
  const markArrived = useCallback(() => {
    if (arrivedRef.current) return;
    if (isBusMode && navPhaseRef.current === "walking") {
      const { apiBaseUrl: base, apiKey: key } = apiRef.current;
      if (shareTokenRef.current) {
        patchShareTrip(base, shareTokenRef.current, { phase: "waiting" }, { apiKey: key ?? undefined, editToken: shareEditTokenRef.current });
      }
      setNavPhase("bus");
      // on_bus PATCH is sent by a separate useEffect watching navPhase === "bus"
      currentTargetRef.current = { lat: alightingLat, lng: alightingLng };
      setDistanceM(null);
      fetchBusDataRef.current();
      return;
    }
    arrivedRef.current = true;
    setArrived(true);
  }, [isBusMode, alightingLat, alightingLng]);

  const finishWalk = useCallback(async () => {
    await addActivityEntry({
      date: todayDateString(),
      walkingModeId: modeId,
      distanceM: Math.round(walkedDistanceMRef.current),
      stepCount,
      durationSeconds,
      caloriesBurned,
      from: "Current location",
      to: destName,
    });
    setShowCompletion(false);
    router.back();
  }, [modeId, stepCount, durationSeconds, caloriesBurned, destName, router]);

  const onCancel = useCallback(() => {
    locationSubRef.current?.remove();
    pedometerSubRef.current?.remove();
    if (timerRef.current) clearInterval(timerRef.current);
    if (vehiclePollRef.current) clearInterval(vehiclePollRef.current);
    router.back();
  }, [router]);

  // The button advances the phase during the bus-mode walking leg and completes the trip
  // otherwise, so the label has to say which one the tap will do.
  const manualArrivalLabel = isBusMode && navPhase === "walking" ? "I'm at the stop" : "I've arrived";

  const target = currentTargetRef.current;
  const etaSeconds = distanceM != null && speedMps > 0 ? Math.round(distanceM / speedMps) : null;
  const etaMinutes = etaSeconds != null ? Math.ceil(etaSeconds / 60) : null;
  // Render-only split of the same formatDistance() string the modal uses.
  const distanceParts = distanceM != null ? splitDistance(distanceM) : null;

  // Pace warning calculation
  const classStartTime = params.arrive_by_class_time as string | undefined;
  let paceStatus: 'on-track' | 'behind' | 'ahead' | null = null;
  let minsUntilClass: number | null = null;
  if (classStartTime && etaMinutes != null) {
    const now = new Date();
    const parts = classStartTime.split(':').map(Number);
    const h = parts[0], m = parts[1];
    if (!isNaN(h) && !isNaN(m)) {
    const classMs = new Date().setHours(h, m, 0, 0);
    minsUntilClass = (classMs - now.getTime()) / 60000;
    const marginMins = minsUntilClass - etaMinutes;
    if (marginMins < -1) paceStatus = 'behind';
    else if (marginMins > 3) paceStatus = 'ahead';
    else paceStatus = 'on-track';
    } // end isNaN guard
  }

  // Snap map center to UIUC if GPS is far away (simulator default = San Francisco)
  const UIUC_CENTER = { lat: 40.102, lng: -88.2272 };
  const rawCenter = userLocation ?? { lat: target.lat, lng: target.lng };
  const rawDistToUiuc = Math.sqrt((rawCenter.lat - UIUC_CENTER.lat) ** 2 + (rawCenter.lng - UIUC_CENTER.lng) ** 2) * 111_000;
  const mapCenter = rawDistToUiuc > 100_000 ? { lat: target.lat, lng: target.lng } : rawCenter;

  return (
    <View style={styles.container}>
      {Platform.OS !== "web" && (
        <MapView
          ref={mapRef}
          style={styles.map}
          provider={Platform.OS === "android" ? PROVIDER_GOOGLE : undefined}
          region={{
            latitude: mapCenter.lat,
            longitude: mapCenter.lng,
            latitudeDelta: zoomDelta,
            longitudeDelta: zoomDelta,
          }}
        >
          {/* User location — navy dot with pulse ring using snapped coords so it shows on UIUC map */}
          {userLocation && (
            <Marker
              coordinate={{ latitude: userLocation.lat, longitude: userLocation.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
            >
              <View style={{ alignItems: "center", justifyContent: "center" }}>
                <View style={{ width: 32, height: 32, borderRadius: 16,
                  backgroundColor: 'rgba(19,41,75,0.15)', position: 'absolute',
                  top: -7, left: -7 }} />
                <View style={styles.userDot} />
              </View>
            </Marker>
          )}

          {/* Intermediate target marker (boarding stop or alighting stop) */}
          <Marker
            coordinate={navPhase === "bus"
              ? { latitude: alightingLat, longitude: alightingLng }
              : { latitude: destLat, longitude: destLng }
            }
            title={navPhase === "bus" ? (alightingStopName || "Alighting stop") : destName}
            pinColor={theme.colors.secondary}
          />

          {/* Final destination pin — always visible */}
          {hasFinalDest && (
            <Marker
              coordinate={{ latitude: finalDestLat, longitude: finalDestLng }}
              anchor={{ x: 0.5, y: 1 }}
              tracksViewChanges={false}
              title={finalDestName}
            >
              <View style={styles.pinWrapper}>
                <View style={styles.pinBulb}>
                  <View style={styles.pinHole} />
                </View>
                <View style={styles.pinTip} />
              </View>
              <Callout tooltip={false}>
                <View style={styles.callout}>
                  <Text style={styles.calloutText}>{finalDestName}</Text>
                </View>
              </Callout>
            </Marker>
          )}

          {/* Dashed walk from alighting stop to final destination */}
          {walkFromBusCoords.length > 1 && (
            <React.Fragment>
              <Polyline
                coordinates={walkFromBusCoords}
                strokeColor="rgba(255,255,255,0.85)"
                strokeWidth={6}
                lineDashPattern={[8, 6]}
                lineCap={"round" as any}
                zIndex={8}
              />
              <Polyline
                coordinates={walkFromBusCoords}
                strokeColor={theme.colors.navy}
                strokeWidth={3}
                lineDashPattern={[8, 6]}
                lineCap={"round" as any}
                zIndex={9}
              />
            </React.Fragment>
          )}

          {/* Walking phase: fetched OSRM route or straight-line fallback */}
          {navPhase === "walking" && walkingRouteCoords.length > 1 && (
            <React.Fragment>
              <Polyline
                coordinates={walkingRouteCoords}
                strokeColor="rgba(255,255,255,0.85)"
                strokeWidth={6}
                lineDashPattern={[8, 6]}
                lineCap={"round" as any}
                zIndex={8}
              />
              <Polyline
                key="walking-route"
                coordinates={walkingRouteCoords}
                strokeColor={theme.colors.navy}
                strokeWidth={3}
                lineDashPattern={[8, 6]}
                lineCap={"round" as any}
                zIndex={9}
              />
            </React.Fragment>
          )}
          {navPhase === "walking" && walkingRouteCoords.length <= 1 && userLocation && (
            <React.Fragment>
              <Polyline
                coordinates={[
                  { latitude: userLocation.lat, longitude: userLocation.lng },
                  { latitude: destLat, longitude: destLng },
                ]}
                strokeColor="rgba(255,255,255,0.85)"
                strokeWidth={6}
                lineDashPattern={[8, 6]}
                lineCap={"round" as any}
                zIndex={8}
              />
              <Polyline
                key="walking-fallback"
                coordinates={[
                  { latitude: userLocation.lat, longitude: userLocation.lng },
                  { latitude: destLat, longitude: destLng },
                ]}
                strokeColor={theme.colors.navy}
                strokeWidth={3}
                lineDashPattern={[8, 6]}
                lineCap={"round" as any}
                zIndex={9}
              />
            </React.Fragment>
          )}

          {/* Bus route shape — visible in BOTH walking and bus phases */}
          {isBusMode && busShapeCoords.length > 1 && (
            <React.Fragment>
              <Polyline
                coordinates={busShapeCoords}
                strokeColor="rgba(19,41,75,0.25)"
                strokeWidth={9}
                lineCap={"round" as any}
                lineJoin={"round" as any}
                zIndex={10}
              />
              <Polyline
                key="bus-shape"
                coordinates={busShapeCoords}
                strokeColor={theme.colors.orange}
                strokeWidth={5}
                lineCap={"round" as any}
                lineJoin={"round" as any}
                zIndex={11}
              />
            </React.Fragment>
          )}

          {/* Bus phase: stop markers */}
          {navPhase === "bus" && busStops.map((s) => (
            s.stop_id === alightingStopId ? (
              <Marker
                key={s.stop_id}
                coordinate={{ latitude: s.lat, longitude: s.lng }}
                title={s.stop_name}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={{
                  width: 22, height: 22, borderRadius: 11,
                  backgroundColor: theme.colors.surface,
                  borderWidth: 3, borderColor: theme.colors.error,
                  shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: 0.3, shadowRadius: 2, elevation: 3,
                }} />
              </Marker>
            ) : (
              <Marker
                key={s.stop_id}
                coordinate={{ latitude: s.lat, longitude: s.lng }}
                title={s.stop_name}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={{
                  width: 14, height: 14, borderRadius: 7,
                  backgroundColor: theme.colors.surface,
                  borderWidth: 2, borderColor: theme.colors.navy,
                }} />
              </Marker>
            )
          ))}

          {/* Live bus vehicles — navy circle with white Bus icon */}
          {busVehicles.map((v) => (
            <Marker
              key={`bus-${v.vehicle_id}`}
              coordinate={{ latitude: v.lat, longitude: v.lng }}
              title={`Bus ${v.route_id}`}
              description={v.headsign || undefined}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
            >
              <View style={styles.busMarker}>
                <Bus size={14} color="#fff" strokeWidth={2.5} />
              </View>
            </Marker>
          ))}
        </MapView>
      )}

      {/* Zoom controls */}
      <View style={styles.zoomControls}>
        <Pressable style={styles.zoomBtn} onPress={zoomIn} accessibilityRole="button" accessibilityLabel="Zoom in">
          <Text style={styles.zoomBtnText}>+</Text>
        </Pressable>
        <View style={styles.zoomDivider} />
        <Pressable style={styles.zoomBtn} onPress={zoomOut} accessibilityRole="button" accessibilityLabel="Zoom out">
          <Text style={styles.zoomBtnText}>−</Text>
        </Pressable>
      </View>

      {/* Top overlay: ONE stacked banner slot + cancel — nothing overlaps */}
      <View style={styles.topOverlay} pointerEvents="box-none">
        <View style={styles.bannerStack} pointerEvents="box-none">
          {locationError && (
            <FadeInView dy={-10} style={[styles.banner, styles.bannerError]}>
              <AlertTriangle size={16} color={theme.colors.textOnNavy} strokeWidth={2.2} />
              <Text style={styles.bannerText}>{locationError}</Text>
            </FadeInView>
          )}
          {!locationError && busMissed && (
            <FadeInView dy={-10} style={[styles.banner, styles.bannerError]}>
              <AlertTriangle size={16} color={theme.colors.textOnNavy} strokeWidth={2.2} />
              <Text style={styles.bannerText}>Bus departed — continue walking to destination</Text>
              <Pressable
                onPress={() => {
                  busMissedDismissedRef.current = true;
                  busMissedRef.current = false;
                  setBusMissed(false);
                }}
                style={styles.bannerAction}
                accessibilityRole="button"
                accessibilityLabel="Dismiss missed-bus notice"
              >
                <Text style={styles.bannerActionText}>Got it</Text>
              </Pressable>
            </FadeInView>
          )}
          {!locationError && !busMissed && isBusMode && navPhase === "walking" && (
            <FadeInView dy={-10} style={[styles.banner, styles.bannerNavy]}>
              <Bus size={16} color={theme.colors.textOnNavy} strokeWidth={2.2} />
              <Text style={styles.bannerText}>Walk to stop · Board Bus {routeId}</Text>
              {busDepEpochMs != null && (
                <View style={styles.bannerChip}>
                  <TickingCountdown targetMs={busDepEpochMs} nowLabel="Departing" style={styles.bannerChipText} />
                </View>
              )}
            </FadeInView>
          )}
          {!locationError && !busMissed && navPhase === "bus" && (
            <FadeInView dy={-10} style={[styles.banner, styles.bannerOrange]}>
              <Bus size={16} color={theme.colors.textOnNavy} strokeWidth={2.2} />
              <Text style={styles.bannerText}>
                On Bus {routeId} · alight at {alightingStopName || "destination stop"}
              </Text>
            </FadeInView>
          )}
        </View>
        <PressableScale
          style={styles.cancelBtn}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={isBusMode ? "Cancel route" : "Cancel walk"}
        >
          <X size={14} color={theme.colors.textOnNavy} strokeWidth={2.4} />
          <Text style={styles.cancelBtnText}>{isBusMode ? "Cancel Route" : "Cancel Walk"}</Text>
        </PressableScale>
      </View>

      {/* HUD overlay — departure-board readout on navy */}
      <View style={styles.hud}>
        <View style={styles.hudTopRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hudEyebrow} numberOfLines={1}>
              {navPhase === "walking" ? `${modeLabel} · Heading to` : `Bus ${routeId} · Alight at`}
            </Text>
            <Text style={styles.hudDest} numberOfLines={1}>
              {navPhase === "walking" ? destName : (alightingStopName || alightingStopId || "destination")}
            </Text>
            {navPhase === "walking" && entranceDesc != null && (
              <Text style={styles.entranceNotice} numberOfLines={1}>→ {entranceDesc}</Text>
            )}
          </View>
          <PressableScale
            accessibilityLabel="Share trip"
            accessibilityRole="button"
            onPress={handleWalkNavShare}
            style={styles.shareBtn}
          >
            <Share2 size={18} color={theme.colors.navy} />
          </PressableScale>
        </View>

        <View style={styles.hudPrimaryRow}>
          <HudPrimaryCell
            label={navPhase === "walking" ? "Distance" : "Dist to stop"}
            a11yLabel={
              distanceParts != null
                ? `${navPhase === "walking" ? "Distance" : "Distance to stop"} ${distanceParts.label}`
                : "Distance unavailable"
            }
          >
            {distanceParts != null ? (
              <HudRollingValue
                whole={distanceParts.whole}
                tenths={distanceParts.tenths}
                unit={distanceParts.unit}
                a11yLabel={distanceParts.label}
              />
            ) : (
              <Text style={styles.hudPrimaryValue} numberOfLines={1}>—</Text>
            )}
          </HudPrimaryCell>
          <View style={styles.hudPrimaryDivider} />
          {navPhase === "walking" ? (
            <HudPrimaryCell
              label="ETA"
              a11yLabel={etaMinutes != null ? `ETA ${etaMinutes} minutes` : "ETA unavailable"}
            >
              {etaMinutes != null ? (
                <HudRollingValue
                  whole={etaMinutes}
                  tenths={null}
                  unit="min"
                  a11yLabel={`ETA ${etaMinutes} minutes`}
                />
              ) : (
                <Text style={styles.hudPrimaryValue} numberOfLines={1}>—</Text>
              )}
            </HudPrimaryCell>
          ) : (
            <HudPrimaryCell
              label="Elapsed"
              a11yLabel={`Elapsed ${Math.floor(durationSeconds / 60)} minutes`}
            >
              <HudElapsedValue totalSeconds={durationSeconds} />
            </HudPrimaryCell>
          )}
        </View>

        <View style={styles.hudStatsRow}>
          {navPhase === "walking" && (
            <HudStat icon={Timer} value={formatElapsed(durationSeconds)} a11yLabel={`Elapsed ${formatElapsed(durationSeconds)}`} />
          )}
          <HudStat icon={Flame} value={`${caloriesBurned.toFixed(1)} kcal`} a11yLabel={`${caloriesBurned.toFixed(1)} kilocalories burned`} />
          {pedometerAvailable && (
            <HudStat icon={Footprints} value={`${stepCount} steps`} a11yLabel={`${stepCount} steps`} />
          )}
        </View>

        {navPhase === "walking" && paceStatus != null && etaMinutes != null && minsUntilClass != null && (
          <PaceChip status={paceStatus} marginMins={minsUntilClass - etaMinutes} />
        )}

        <View style={styles.hudFooter}>
          <PressableScale
            accessibilityLabel={manualArrivalLabel}
            accessibilityRole="button"
            onPress={markArrived}
            style={styles.arrivedBtn}
          >
            <LinearGradient
              colors={theme.gradients.sunset}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.arrivedFill}
            >
              <Check size={18} color={theme.colors.surface} strokeWidth={2.6} />
              <Text style={styles.arrivedText}>{manualArrivalLabel}</Text>
            </LinearGradient>
          </PressableScale>
        </View>
      </View>

      {shareErrorToast && (
        <View style={styles.shareErrorToast}>
          <Text style={styles.shareErrorToastText}>{shareErrorToast}</Text>
        </View>
      )}

      {/* Completion modal — ring closes, haptic, burst, then the tiles rise in */}
      <Modal visible={showCompletion} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <ArrivalCard
            destName={destName}
            distanceLabel={formatDistance(walkedDistanceMRef.current)}
            durationLabel={formatElapsed(durationSeconds)}
            energyLabel={`${caloriesBurned.toFixed(1)} kcal`}
            stepsLabel={pedometerAvailable ? String(stepCount) : null}
            encouragement={encouragement}
            onFinish={finishWalk}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  userDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.navy,
    borderWidth: 3,
    borderColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 4,
  },
  busMarker: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.colors.navy,
    borderWidth: 2,
    borderColor: theme.colors.orange,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 5,
  },

  // ── Top overlay: single stacked banner slot + cancel ────────────────────
  topOverlay: {
    position: "absolute",
    top: 48,
    left: theme.layout.gutter,
    right: theme.layout.gutter,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    zIndex: 20,
  },
  bannerStack: { flex: 1, gap: 8 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: theme.radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...theme.elevation[2],
  },
  bannerNavy: { backgroundColor: theme.colors.navy },
  bannerOrange: { backgroundColor: theme.colors.ctaEnd },
  bannerError: { backgroundColor: theme.colors.errorDeep },
  bannerText: {
    ...theme.text.subhead,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.textOnNavy,
    flex: 1,
  },
  bannerChip: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  bannerChipText: {
    ...theme.text.numeric,
    fontSize: 13,
    color: theme.colors.brandInk,
  },
  bannerAction: {
    minHeight: theme.layout.tapMin,
    minWidth: theme.layout.tapMin,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    marginVertical: -10,
  },
  bannerActionText: {
    ...theme.text.subhead,
    fontSize: 13,
    color: theme.colors.textOnNavy,
    textDecorationLine: "underline",
  },
  cancelBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minHeight: theme.layout.tapMin,
    paddingHorizontal: 14,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.errorDeep,
    ...theme.elevation[2],
  },
  cancelBtnText: {
    ...theme.text.subhead,
    fontSize: 13,
    color: theme.colors.textOnNavy,
  },

  // ── HUD ─────────────────────────────────────────────────────────────────
  hud: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(11,27,54,0.94)",
    paddingHorizontal: theme.layout.gutter,
    paddingTop: 14,
    paddingBottom: 32,
    borderTopLeftRadius: theme.radius.xxl,
    borderTopRightRadius: theme.radius.xxl,
    shadowColor: "#0B1B36",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 12,
  },
  hudTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  hudEyebrow: {
    ...theme.text.eyebrow,
    color: theme.colors.textOnNavyMuted,
    marginBottom: 2,
  },
  hudDest: {
    ...theme.text.title2,
    color: theme.colors.textOnNavy,
  },
  entranceNotice: {
    ...theme.text.caption,
    fontSize: 12,
    color: theme.colors.textOnNavyMuted,
    marginTop: 2,
  },
  shareBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
    ...theme.elevation[2],
  },
  hudPrimaryRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  hudPrimaryCell: { flex: 1, alignItems: "center", gap: 2 },
  hudPrimaryDivider: {
    width: 1,
    height: 44,
    backgroundColor: theme.colors.textOnNavyMuted,
    opacity: 0.35,
  },
  hudPrimaryLabel: {
    ...theme.text.eyebrow,
    color: theme.colors.textOnNavyMuted,
  },
  hudPrimaryValue: {
    ...theme.text.display,
    fontSize: 40,
    lineHeight: 46,
    color: theme.colors.textOnNavy,
  },
  // The odometer sizes its digit window from lineHeight, so the row only has to
  // line the columns up next to each other.
  hudValueRow: { flexDirection: "row", alignItems: "center" },
  hudPrimaryUnit: {
    ...theme.text.numeric,
    fontSize: 15,
    lineHeight: 46,
    marginLeft: 5,
    color: theme.colors.textOnNavyMuted,
  },
  hudStatsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
    marginBottom: 4,
  },
  hudStat: { flexDirection: "row", alignItems: "center", gap: 5 },
  hudStatValue: {
    ...theme.text.numeric,
    fontSize: 13,
    color: theme.colors.textOnNavy,
  },
  paceChip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    alignSelf: "center",
    borderRadius: theme.radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 6,
    // Static fallback so the pill is never colourless on its first frame, before
    // the animated fill has run once.
    backgroundColor: theme.colors.mint,
  },
  // Fill comes from the animated mint -> amber ramp; navy ink clears AA on both
  // ends of it, which white ink would not.
  paceChipText: {
    ...theme.text.badge,
    color: theme.colors.navyDeep,
  },
  hudFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
  },
  arrivedBtn: {
    flex: 1,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    minHeight: 50,
    ...theme.shadows.glowOrange,
  },
  arrivedFill: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  arrivedText: {
    ...theme.text.heading,
    fontSize: 16,
    color: theme.colors.surface,
  },

  // ── Toast ───────────────────────────────────────────────────────────────
  shareErrorToast: {
    position: "absolute",
    bottom: 260,
    left: 24,
    right: 24,
    backgroundColor: theme.colors.navyDeep,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
    zIndex: 30,
    ...theme.elevation[3],
  },
  shareErrorToastText: {
    ...theme.text.caption,
    color: theme.colors.textOnNavy,
  },

  // ── Completion modal ────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xxl,
    padding: 24,
    width: "100%",
    alignItems: "center",
    ...theme.elevation[3],
  },
  ringWrap: { marginBottom: 10 },
  modalHalo: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: theme.colors.orangeSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  modalEyebrow: {
    ...theme.text.eyebrow,
    color: theme.colors.brandInk,
    marginBottom: 4,
  },
  modalTitle: {
    ...theme.text.title1,
    color: theme.colors.navy,
    marginBottom: 2,
  },
  modalDest: {
    ...theme.text.body,
    color: theme.colors.textSecondary,
    textAlign: "center",
    marginBottom: 16,
  },
  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.layout.cardGap,
    alignSelf: "stretch",
    marginBottom: 16,
  },
  // Stagger wraps each tile in its own Animated.View, so the flex sizing has to
  // live on that wrapper — the tile itself just fills it.
  statTileWrap: { flexGrow: 1, flexBasis: "40%" },
  statTile: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.lg,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: "center",
    gap: 3,
  },
  statTileValue: {
    ...theme.text.numeric,
    fontSize: 18,
    lineHeight: 24,
    color: theme.colors.text,
  },
  statTileLabel: {
    ...theme.text.eyebrow,
    fontSize: 10,
    color: theme.colors.textMuted,
  },
  encouragementText: {
    ...theme.text.body,
    fontStyle: "italic",
    color: theme.colors.brandInk,
    textAlign: "center",
    marginBottom: 16,
    paddingHorizontal: 8,
  },
  modalCtaWrap: { alignSelf: "stretch" },
  burstLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },

  // ── Map pins / callouts / zoom (unchanged vocabulary) ───────────────────
  pinWrapper: { alignItems: "center" },
  pinBulb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.colors.navy,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 4,
  },
  pinHole: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#fff",
  },
  pinTip: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 8,
    borderStyle: "solid",
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: theme.colors.navy,
    marginTop: -1,
  },
  callout: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 120,
    maxWidth: 220,
  },
  calloutText: {
    ...theme.text.subhead,
    fontSize: 13,
    color: theme.colors.navy,
    textAlign: "center",
  },
  zoomControls: {
    position: "absolute",
    top: 104,
    right: theme.layout.gutter,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    ...theme.elevation[3],
    zIndex: 10,
  },
  zoomBtn: {
    width: theme.layout.tapMin,
    height: theme.layout.tapMin,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomBtnText: {
    fontSize: 22,
    fontFamily: "DMSans_400Regular",
    color: theme.colors.navy,
    lineHeight: 26,
  },
  zoomDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginHorizontal: 8,
  },
});
