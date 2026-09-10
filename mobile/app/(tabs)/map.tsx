import { fetchAutocomplete, fetchBusRouteStops, fetchPlaceDetails, fetchRecommendation, fetchWalkingRoute, fetchCrowding } from "@/src/api/client";
import type { AutocompleteResult } from "@/src/api/client";
import type { RecommendationOption, StopInfo, CrowdingInfo, VehicleInfo } from "@/src/api/types";
import { CrowdingSheet } from "@/src/components/CrowdingSheet";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { useRecommendationSettings } from "@/src/hooks/useRecommendationSettings";
import { formatDistance, haversineMeters } from "@/src/utils/distance";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnalytics } from "@/src/hooks/useAnalytics";
import React from "react";
import { useVehicles } from "@/src/queries/map";
import { useDepartures, useNearbyStops } from "@/src/queries/departures";
import {
  ActivityIndicator,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "@/src/constants/theme";
import { STAGGER } from "@/src/constants/motion";
import { FadeInView, PressableScale, Skeleton, Stagger } from "@/src/components/ui/motion";
import { VehicleMarker, vehicleMarkerKey } from "@/src/components/map";
import { Sheet, type SheetExternalGesture } from "@/src/components/ui/Sheet";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { DepartureRow } from "@/src/components/ui/DepartureRow";
import { EmptyState } from "@/src/components/ui/EmptyState";
import { Bus, CloudOff, Footprints, MapPin, Search, X } from "lucide-react-native";

/** Live vehicles chip — the shared Badge pairs its breathing dot with text and respects reduce-motion. */
function MapLiveBadge({ count }: { count: number }) {
  return <Badge label={`LIVE · ${count} ${count === 1 ? "bus" : "buses"}`} variant="live" size="md" />;
}

/**
 * Detents for the stop sheet: closed, a peek that leaves most of the map
 * visible, and a near-full read of the departure board.
 *
 * `Sheet` sizes its surface to the LARGEST detent, so the content box is
 * always 0.85 of the screen; at 0.45 the lower half simply sits below the
 * fold. That is why the departures list scrolls rather than being trimmed.
 */
const STOP_SNAP_POINTS = [0, 0.45, 0.85] as const;
/** The detent a freshly picked stop opens at. */
const STOP_PEEK_INDEX = 1;

/**
 * How many buses may glide at once.
 *
 * `VehicleMarker`'s glide is an `AnimatedRegion`, and there is no native
 * driver for a map coordinate — every gliding puck drives JS-thread frames for
 * `GLIDE.vehicle` ms after each 15s poll. Forty is the ceiling the marker's own
 * docs give; past that the whole screen janks once per poll. Everything else
 * gets `glide={false}`, which snaps.
 */
const GLIDE_BUDGET = 40;

/**
 * Render-only stop marker: a quiet navy dot that grows (with an orange core)
 * when selected.
 *
 * The dot is 12-24pt but the marker it rasterizes into is 44x44 and centred on
 * the coordinate, so the tap target clears the accessibility minimum without
 * the dot itself growing — the same trick `VehicleMarker` uses for its puck.
 * Padding it out here (rather than with `hitSlop`, which a native map marker
 * does not honour) is the only way to widen the target.
 */
function StopDot({ selected }: { selected: boolean }) {
  return (
    <View style={markerStyles.stopTapTarget}>
      {selected ? (
        <View style={markerStyles.stopSelectedOuter}>
          <View style={markerStyles.stopSelectedInner} />
        </View>
      ) : (
        <View style={markerStyles.stopIdle} />
      )}
    </View>
  );
}

const INITIAL_DELTA = 0.008;
const UIUC_FALLBACK = { lat: 40.1020, lng: -88.2272 };

type StopWithDistance = StopInfo & { distance_m: number };

export default function MapScreen() {
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const { walkingModeId, walkingSpeedMps, bufferMinutes } = useRecommendationSettings();
  const router = useRouter();
  const { capture } = useAnalytics();

  useFocusEffect(
    useCallback(() => {
      capture("map_viewed");
    }, [capture])
  );
  const [status, setStatus] = useState<"loading" | "denied" | "error" | "ready">("loading");
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(UIUC_FALLBACK);
  const [selectedStop, setSelectedStop] = useState<StopWithDistance | null>(null);
  const [useUiucArea, setUseUiucArea] = useState(false);

  // TanStack Query: vehicles (15s polling). Query data is structurally
  // shared, so `vehiclesData` keeps its identity across no-change polls and
  // this memo (unlike a bare `?? []`) does too.
  const { data: vehiclesData } = useVehicles();
  const vehicles = useMemo(() => vehiclesData?.vehicles ?? [], [vehiclesData]);

  // TanStack Query: nearby stops (reactive on location)
  const { data: nearbyStopsData } = useNearbyStops(
    location?.lat ?? 0,
    location?.lng ?? 0,
    { enabled: !!location && status === "ready" }
  );
  const stops: StopWithDistance[] = useMemo(
    () =>
      (nearbyStopsData?.stops ?? [])
        .map((s) => ({
          ...s,
          distance_m: Math.round(haversineMeters(location?.lat ?? 0, location?.lng ?? 0, s.lat, s.lng)),
        }))
        .sort((a, b) => a.distance_m - b.distance_m),
    [nearbyStopsData, location]
  );

  // TanStack Query: departures for selected stop
  const {
    data: departuresData,
    isLoading: departuresLoading,
    isError: departuresError,
    refetch: refetchDepartures,
  } = useDepartures(
    selectedStop?.stop_id ?? "",
    { enabled: !!selectedStop }
  );
  const departures = departuresData?.departures ?? [];

  // Place search state
  const [mapSearch, setMapSearch] = useState("");
  const [suggestions, setSuggestions] = useState<AutocompleteResult[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<{ lat: number; lng: number; name: string; building_id?: string } | null>(null);
  const [placeRoutes, setPlaceRoutes] = useState<RecommendationOption[]>([]);
  const [placeRoutesLoading, setPlaceRoutesLoading] = useState(false);
  const [routesError, setRoutesError] = useState(false);
  // Bumped by the Retry button to re-run the routes fetch effect.
  const [routesAttempt, setRoutesAttempt] = useState(0);
  const [selectedRouteIdx, setSelectedRouteIdx] = useState(0);
  type LatLng = { latitude: number; longitude: number };
  const [walkPolylines, setWalkPolylines] = useState<LatLng[][]>([]);
  const [busPolylines, setBusPolylines] = useState<LatLng[][]>([]);

  const [vehicleCrowding, setVehicleCrowding] = useState<Record<string, CrowdingInfo>>({});
  const [crowdingSheet, setCrowdingSheet] = useState<{ vehicleId: string; routeId: string } | null>(null);

  const mapRef = useRef<MapView | null>(null);
  const currentRegionRef = useRef({
    latitude: UIUC_FALLBACK.lat,
    longitude: UIUC_FALLBACK.lng,
    latitudeDelta: INITIAL_DELTA,
    longitudeDelta: INITIAL_DELTA,
  });

  const zoomIn = useCallback(() => {
    const r = currentRegionRef.current;
    const next = { ...r, latitudeDelta: r.latitudeDelta / 2, longitudeDelta: r.longitudeDelta / 2 };
    currentRegionRef.current = next;
    mapRef.current?.animateToRegion(next, 200);
  }, []);

  const zoomOut = useCallback(() => {
    const r = currentRegionRef.current;
    const next = {
      ...r,
      latitudeDelta: Math.min(r.latitudeDelta * 2, 80),
      longitudeDelta: Math.min(r.longitudeDelta * 2, 80),
    };
    currentRegionRef.current = next;
    mapRef.current?.animateToRegion(next, 200);
  }, []);

  const centerOnMe = useCallback(() => {
    const loc = location ?? UIUC_FALLBACK;
    if (!mapRef.current) return;
    mapRef.current.animateToRegion({
      latitude: loc.lat,
      longitude: loc.lng,
      latitudeDelta: INITIAL_DELTA,
      longitudeDelta: INITIAL_DELTA,
    }, 500);
  }, [location]);

  const loadStops = useCallback(async () => {
    setStatus("loading");
    let latitude: number;
    let longitude: number;

    if (useUiucArea) {
      latitude = UIUC_FALLBACK.lat;
      longitude = UIUC_FALLBACK.lng;
      setLocation(UIUC_FALLBACK);
    } else {
      try {
        const { status: perm } = await Location.requestForegroundPermissionsAsync();
        if (perm !== "granted") {
          setStatus("denied");
          setLocation(null);
          return;
        }
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        latitude = loc.coords.latitude;
        longitude = loc.coords.longitude;
        const distToUiuc = haversineMeters(latitude, longitude, UIUC_FALLBACK.lat, UIUC_FALLBACK.lng);
        if (distToUiuc > 100_000) {
          latitude = UIUC_FALLBACK.lat;
          longitude = UIUC_FALLBACK.lng;
        }
        setLocation({ lat: latitude, lng: longitude });
      } catch {
        // GPS unavailable (e.g. simulator) — show the error UI; the
        // "Use UIUC area instead" button remains the explicit fallback.
        setStatus("error");
        return;
      }
    }

    setStatus("ready");
  }, [useUiucArea]);

  useEffect(() => {
    loadStops();
  }, [loadStops]);

  // Debounced autocomplete for place search
  useEffect(() => {
    const q = mapSearch.trim();
    if (q.length < 2) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await fetchAutocomplete(apiBaseUrl, q, { apiKey: apiKey ?? undefined });
        setSuggestions(res.results ?? []);
      } catch {
        setSuggestions([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [mapSearch, apiBaseUrl, apiKey]);

  // Fetch routes when a place is selected (or Retry bumps `routesAttempt`)
  useEffect(() => {
    if (!selectedPlace || !location) return;
    setPlaceRoutesLoading(true);
    setPlaceRoutes([]);
    setRoutesError(false);
    const arriveBy = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    (async () => {
      try {
        const rec = await fetchRecommendation(apiBaseUrl, {
          lat: location.lat,
          lng: location.lng,
          ...(selectedPlace.building_id
            ? { destination_building_id: selectedPlace.building_id }
            : { destination_lat: selectedPlace.lat, destination_lng: selectedPlace.lng, destination_name: selectedPlace.name }),
          arrive_by_iso: arriveBy,
          max_options: 3,
          walking_speed_mps: walkingSpeedMps,
          buffer_minutes: bufferMinutes,
        }, { apiKey: apiKey ?? undefined });
        setPlaceRoutes(rec.options ?? []);
      } catch {
        setPlaceRoutes([]);
        setRoutesError(true);
      } finally {
        setPlaceRoutesLoading(false);
      }
    })();
  }, [selectedPlace, location, apiBaseUrl, apiKey, walkingSpeedMps, bufferMinutes, routesAttempt]);

  const retryPlaceRoutes = useCallback(() => {
    setRoutesAttempt((a) => a + 1);
  }, []);

  // Reset route index when fresh routes arrive
  useEffect(() => {
    setSelectedRouteIdx(0);
  }, [placeRoutes]);

  // Fetch walk + bus polylines for the selected route option
  useEffect(() => {
    if (!placeRoutes.length || !location || !selectedPlace) {
      setWalkPolylines([]);
      setBusPolylines([]);
      return;
    }
    const opt = placeRoutes[selectedRouteIdx];
    if (!opt) return;
    let cancelled = false;

    (async () => {
      const newWalk: { latitude: number; longitude: number }[][] = [];
      const newBus: { latitude: number; longitude: number }[][] = [];
      let prevLat = location.lat;
      let prevLng = location.lng;

      for (const step of opt.steps) {
        if (step.type === "WALK_TO_STOP" && step.stop_lat != null && step.stop_lng != null) {
          const [dLat, dLng] = [step.stop_lat, step.stop_lng];
          try {
            const res = await fetchWalkingRoute(apiBaseUrl, prevLat, prevLng, dLat, dLng, { apiKey: apiKey ?? undefined });
            newWalk.push(
              res.coords.length >= 2
                ? res.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))
                : [{ latitude: prevLat, longitude: prevLng }, { latitude: dLat, longitude: dLng }]
            );
          } catch {
            newWalk.push([{ latitude: prevLat, longitude: prevLng }, { latitude: dLat, longitude: dLng }]);
          }
          prevLat = dLat;
          prevLng = dLng;
        } else if (step.type === "RIDE" && step.route && step.stop_id) {
          // Alighting coords — if missing and WALK_TO_DEST follows, skip bus line (walk handles last mile)
          const hasWalkToDest = opt.steps.some(s => s.type === "WALK_TO_DEST");
          const aLatRaw = step.alighting_stop_lat ?? (hasWalkToDest ? null : selectedPlace.lat);
          const aLngRaw = step.alighting_stop_lng ?? (hasWalkToDest ? null : selectedPlace.lng);

          if (aLatRaw != null && aLngRaw != null) {
            const aLat = aLatRaw;
            const aLng = aLngRaw;

            const roadFallback = async () => {
              try {
                const w = await fetchWalkingRoute(apiBaseUrl, prevLat, prevLng, aLat, aLng, { apiKey: apiKey ?? undefined });
                return w.coords.length >= 2
                  ? w.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))
                  : [{ latitude: prevLat, longitude: prevLng }, { latitude: aLat, longitude: aLng }];
              } catch {
                return [{ latitude: prevLat, longitude: prevLng }, { latitude: aLat, longitude: aLng }];
              }
            };

            if (step.alighting_stop_id) {
              const afterTime = new Date().toTimeString().slice(0, 5);
              try {
                const res = await fetchBusRouteStops(apiBaseUrl, step.route, step.stop_id, step.alighting_stop_id, afterTime, { apiKey: apiKey ?? undefined });
                newBus.push(
                  res.shape_points.length >= 2
                    ? res.shape_points.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))
                    : await roadFallback()
                );
              } catch {
                newBus.push(await roadFallback());
              }
            } else {
              newBus.push(await roadFallback());
            }
            prevLat = aLat;
            prevLng = aLng;
          }
          // else: no alighting coords + WALK_TO_DEST follows → skip bus line, prevLat/Lng unchanged
        } else if (step.type === "WALK_TO_DEST") {
          const dLat = selectedPlace.lat;
          const dLng = selectedPlace.lng;
          try {
            const res = await fetchWalkingRoute(apiBaseUrl, prevLat, prevLng, dLat, dLng, { apiKey: apiKey ?? undefined });
            newWalk.push(
              res.coords.length >= 2
                ? res.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))
                : [{ latitude: prevLat, longitude: prevLng }, { latitude: dLat, longitude: dLng }]
            );
          } catch {
            newWalk.push([{ latitude: prevLat, longitude: prevLng }, { latitude: dLat, longitude: dLng }]);
          }
        }
      }

      // WALK-only with no step breakdown
      if (opt.type === "WALK" && newWalk.length === 0) {
        try {
          const res = await fetchWalkingRoute(apiBaseUrl, location.lat, location.lng, selectedPlace.lat, selectedPlace.lng, { apiKey: apiKey ?? undefined });
          newWalk.push(
            res.coords.length >= 2
              ? res.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))
              : [{ latitude: location.lat, longitude: location.lng }, { latitude: selectedPlace.lat, longitude: selectedPlace.lng }]
          );
        } catch {
          newWalk.push([{ latitude: location.lat, longitude: location.lng }, { latitude: selectedPlace.lat, longitude: selectedPlace.lng }]);
        }
      }

      if (cancelled) return;
      setWalkPolylines(newWalk);
      setBusPolylines(newBus);

      // Fit map to show the full route
      const all = [...newWalk.flat(), ...newBus.flat()];
      if (all.length >= 2 && mapRef.current) {
        mapRef.current.fitToCoordinates(all, {
          edgePadding: { top: 100, right: 40, bottom: 320, left: 40 },
          animated: true,
        });
      }
    })();

    return () => { cancelled = true; };
  }, [placeRoutes, selectedRouteIdx, location, selectedPlace, apiBaseUrl, apiKey]);

  const onSelectSuggestion = useCallback(async (result: AutocompleteResult) => {
    Keyboard.dismiss();
    setMapSearch(result.name);
    setSuggestions([]);
    setSelectedStop(null);

    let lat = result.lat;
    let lng = result.lng;
    let name = result.display_name ?? result.name;

    if (lat !== 0 && lng !== 0) {
      // Coords already embedded — use directly
    } else if (result.type === "google_place" && result.place_id) {
      // Fallback: resolve via /places/details when backend didn't embed coords
      try {
        const details = await fetchPlaceDetails(apiBaseUrl, result.place_id, { apiKey: apiKey ?? undefined });
        lat = details.lat;
        lng = details.lng;
        if (details.display_name) name = details.display_name;
      } catch {
        // Leave lat/lng as 0 — setSelectedPlace will still be set but map won't animate meaningfully
      }
    }

    setSelectedPlace({ lat, lng, name, building_id: result.building_id });
    mapRef.current?.animateToRegion({
      latitude: lat,
      longitude: lng,
      latitudeDelta: INITIAL_DELTA,
      longitudeDelta: INITIAL_DELTA,
    }, 500);
  }, [apiBaseUrl, apiKey]);

  const clearSearch = useCallback(() => {
    setMapSearch("");
    setSuggestions([]);
    setSelectedPlace(null);
    setPlaceRoutes([]);
    setRoutesError(false);
    setWalkPolylines([]);
    setBusPolylines([]);
    setSelectedRouteIdx(0);
  }, []);

  const onStartNavigation = useCallback((opt: RecommendationOption) => {
    if (!selectedPlace) return;
    if (opt.type === "WALK") {
      router.push({
        pathname: "/walk-nav",
        params: {
          dest_lat: String(selectedPlace.lat),
          dest_lng: String(selectedPlace.lng),
          dest_name: selectedPlace.name,
          walking_mode_id: walkingModeId,
        },
      });
    } else {
      const walkStep = opt.steps.find((s) => s.type === "WALK_TO_STOP");
      const rideStep = opt.steps.find((s) => s.type === "RIDE");
      router.push({
        pathname: "/walk-nav",
        params: {
          dest_lat: String(walkStep?.stop_lat ?? selectedPlace.lat),
          dest_lng: String(walkStep?.stop_lng ?? selectedPlace.lng),
          dest_name: walkStep?.stop_name ?? selectedPlace.name,
          walking_mode_id: walkingModeId,
          route_id: rideStep?.route ?? "",
          stop_id: walkStep?.stop_id ?? "",
          alighting_stop_id: rideStep?.alighting_stop_id ?? "",
          alighting_lat: String(rideStep?.alighting_stop_lat ?? ""),
          alighting_lng: String(rideStep?.alighting_stop_lng ?? ""),
          final_lat: String(selectedPlace.lat),
          final_lng: String(selectedPlace.lng),
          final_name: selectedPlace.name,
        },
      });
    }
  }, [selectedPlace, walkingModeId, router]);

  const onMarkerPress = useCallback(
    (stop: StopWithDistance) => {
      setSelectedStop(stop);
      setSelectedPlace(null);
      setPlaceRoutes([]);
      setMapSearch("");
      setSuggestions([]);
    },
    []
  );

  const onOpenTrip = useCallback(
    (stop: StopWithDistance) => {
      router.push({
        pathname: "/trip",
        params: { stop_id: stop.stop_id, stop_name: stop.stop_name },
      });
    },
    [router]
  );

  // `VehicleMarker` is memoized, so an inline arrow here would give every puck
  // a new `onPress` on every render and defeat that memo. Same body as before.
  const onVehiclePress = useCallback((v: VehicleInfo) => {
    setCrowdingSheet({ vehicleId: v.vehicle_id, routeId: v.route_id });
  }, []);

  // ── Which buses are allowed to glide ────────────────────────────────────
  // Recomputed only when a poll delivers a new `vehicles` array, which is also
  // the only moment the answer is used: the markers re-render, each one reads
  // its flag, and the glide either starts or the puck snaps.
  //
  // `currentRegionRef` is read rather than mirrored into state on purpose.
  // `onRegionChangeComplete` fires at the end of every pan and pinch; turning
  // that into a `setState` would re-render the entire map screen — and every
  // marker on it — for a value that is only ever consulted here. The ref is
  // current by the time a poll lands, and a bus that drifts out of view
  // between polls just finishes the glide it already started.
  const glidingVehicleIds = useMemo(() => {
    const r = currentRegionRef.current;
    const latPad = r.latitudeDelta / 2;
    const lngPad = r.longitudeDelta / 2;
    const visible: { id: string; d2: number }[] = [];
    for (const v of vehicles) {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
      const dLat = v.lat - r.latitude;
      const dLng = v.lng - r.longitude;
      // Champaign-Urbana never crosses the antimeridian, so a plain box test
      // is the whole story; no longitude wrapping needed.
      if (Math.abs(dLat) > latPad || Math.abs(dLng) > lngPad) continue;
      visible.push({ id: v.vehicle_id, d2: dLat * dLat + dLng * dLng });
    }
    // If more buses are on screen than the budget allows, spend it on the ones
    // nearest the centre of the map — the ones the eye is actually on.
    if (visible.length > GLIDE_BUDGET) visible.sort((a, b) => a.d2 - b.d2);
    return new Set(visible.slice(0, GLIDE_BUDGET).map((v) => v.id));
  }, [vehicles]);

  // A stable fingerprint of the gliding set's MEMBERSHIP. The Set above gets a
  // new identity every 15s vehicle poll (positions moved); this string only
  // changes when a bus actually enters or leaves the capped set, so the
  // crowding effect below restarts (and re-polls immediately) exactly then.
  const glidingIdsKey = useMemo(
    () => Array.from(glidingVehicleIds).sort().join(","),
    [glidingVehicleIds]
  );

  // ── Crowding poll, bounded to the gliding/visible capped set ────────────
  // Previously this fired one fetchCrowding per vehicle for the WHOLE fleet
  // every 30s. Now it polls only the ≤GLIDE_BUDGET buses the user can see —
  // the only ones whose crowding ring is on screen. Entries for buses that
  // drift out of the set keep their last-known value (same as before, when a
  // vehicle left the feed).
  useEffect(() => {
    if (!glidingIdsKey || !apiBaseUrl) return;
    let cancelled = false;
    async function pollCrowding() {
      const targets = vehicles.filter((v) => glidingVehicleIds.has(v.vehicle_id));
      if (!targets.length) return;
      const updates: Record<string, CrowdingInfo> = {};
      await Promise.all(
        targets.map(async (v) => {
          const info = await fetchCrowding(apiBaseUrl, v.vehicle_id, v.route_id, { apiKey: apiKey ?? undefined });
          if (info) updates[v.vehicle_id] = info;
        })
      );
      if (cancelled) return;
      // Identity-stable write: a no-op poll (same level + source per vehicle)
      // returns `prev` untouched, and an unchanged entry keeps its previous
      // object, so `VehicleMarker`'s memo (and `vehicleMarkerKey`) survive.
      setVehicleCrowding((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, info] of Object.entries(updates)) {
          const old = prev[id];
          if (old && old.level === info.level && old.source === info.source) continue;
          next[id] = info;
          changed = true;
        }
        return changed ? next : prev;
      });
    }
    pollCrowding();
    const id = setInterval(pollCrowding, 30_000);
    return () => { cancelled = true; clearInterval(id); };
    // `vehicles`/`glidingVehicleIds` are read through the closure on purpose:
    // membership is what matters, and `glidingIdsKey` restarts the effect
    // whenever that changes. route_id staleness between restarts matches the
    // previous id-joined dependency exactly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glidingIdsKey, apiBaseUrl, apiKey]);

  // Per-stop coordinate objects and onPress handlers, hoisted out of the
  // marker JSX so a re-render of the screen hands every <Marker> the same
  // props it had last time.
  const stopMarkers = useMemo(
    () =>
      stops.map((stop) => ({
        stop,
        coordinate: { latitude: stop.lat, longitude: stop.lng },
        distanceLabel: `${formatDistance(stop.distance_m)} away`,
        onPress: () => onMarkerPress(stop),
      })),
    [stops, onMarkerPress]
  );

  // ── Stop sheet detent ───────────────────────────────────────────────────
  // The sheet is mounted for the life of the screen and driven by `index`;
  // detent 0 is "closed", which is what `selectedStop === null` means. Keeping
  // it mounted is what lets a selection animate the sheet up instead of
  // popping a freshly mounted surface into place.
  const [stopDetent, setStopDetent] = useState<number>(STOP_PEEK_INDEX);
  const stopSheetOpen = !!selectedStop && !selectedPlace;
  const stopSheetIndex = stopSheetOpen ? stopDetent : 0;

  const onStopSheetIndexChange = useCallback((next: number) => {
    if (next === 0) {
      // Dragging (or flinging) to the closed detent is the sheet's dismiss
      // affordance, so it drops the selection exactly the way picking a place
      // already did. Without this, re-tapping the same stop would leave
      // `selectedStop` unchanged and the sheet would stay shut.
      setStopDetent(STOP_PEEK_INDEX);
      setSelectedStop(null);
      return;
    }
    setStopDetent(next);
  }, []);

  // Retain what the sheet is showing while it springs closed. Clearing
  // `selectedStop` disables the departures query in the same commit, so
  // without this the sheet would blank to "No departures" for the length of
  // the close animation.
  const lastStopRef = useRef<StopWithDistance | null>(null);
  const lastDeparturesRef = useRef<typeof departures>([]);

  // RNGH's `GestureRef` models a ref to a *gesture* or to a component TYPE; a
  // MapView ref is `RefObject<MapView | null>`, an INSTANCE that may be null,
  // so the published type has no shape for it and this cast is that gap.
  // Be aware the runtime does not accept it either: RNGH reads
  // `ref.current?.handlerTag` and drops anything that resolves to -1, which a
  // MapView does. See the note on the prop below.
  // The ref object itself is reference-stable, so the memoized pan gesture
  // inside `Sheet` is never rebuilt because of it.
  const mapGestureRef = mapRef as unknown as SheetExternalGesture;

  if (Platform.OS === "web") {
    return (
      <View style={styles.centered}>
        <Text style={styles.fallbackTitle}>Map</Text>
        <Text style={styles.fallbackText}>
          The map is not available on web. Use the iOS or Android app.
        </Text>
        <Text style={styles.fallbackHint}>See docs for adding Google Maps API keys on native.</Text>
      </View>
    );
  }

  if (status === "denied") {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Location permission denied</Text>
        <Text style={styles.hint}>Enable location in Settings, or use the UIUC area to see the map.</Text>
        <Pressable
          style={styles.retryBtn}
          onPress={() => Linking.openSettings()}
          accessibilityLabel="Open location settings"
          accessibilityRole="button"
        >
          <Text style={styles.retryBtnText}>Open Location Settings</Text>
        </Pressable>
        {/* Only flip the flag: the loadStops useCallback closes over the old
            useUiucArea, so calling it here would retry GPS and its late
            setStatus could clobber the effect-driven reload that the flag
            change triggers via useEffect([loadStops]). */}
        <Pressable
          style={[styles.retryBtn, styles.retryBtnSecondary]}
          onPress={() => setUseUiucArea(true)}
          accessibilityRole="button"
          accessibilityLabel="Use UIUC area, Champaign-Urbana"
        >
          <Text style={styles.retryBtnSecondaryText}>Use UIUC area (Champaign-Urbana)</Text>
        </Pressable>
      </View>
    );
  }

  if (status === "error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Could not load stops</Text>
        <Text style={styles.hint}>Check API URL in Settings and try again.</Text>
        <Pressable style={styles.retryBtn} onPress={loadStops} accessibilityRole="button" accessibilityLabel="Retry loading stops">
          <Text style={styles.retryBtnText}>Retry</Text>
        </Pressable>
        {/* Only flip the flag (see comment on the denied screen): the stale
            loadStops closure would retry GPS, fail, and set "error" after the
            effect-driven reload already set "ready". */}
        <Pressable
          style={[styles.retryBtn, styles.retryBtnSecondary]}
          onPress={() => setUseUiucArea(true)}
          accessibilityRole="button"
          accessibilityLabel="Use UIUC area instead"
        >
          <Text style={styles.retryBtnSecondaryText}>Use UIUC area instead</Text>
        </Pressable>
      </View>
    );
  }

  // Idempotent render-phase latch (see `lastStopRef`): while a stop is
  // selected these track it, and once it is cleared they keep feeding the
  // sheet its last contents until the close animation is done.
  if (selectedStop) {
    lastStopRef.current = selectedStop;
    lastDeparturesRef.current = departures;
  }
  const sheetStop = selectedStop ?? lastStopRef.current;
  const sheetDepartures = selectedStop ? departures : lastDeparturesRef.current;
  // Only surface the query error while a stop is actually selected; a closing
  // sheet keeps showing its latched contents, never a late-arriving error.
  const sheetDeparturesError = !!selectedStop && departuresError;

  const mapCenter = location ?? UIUC_FALLBACK;
  const initialRegion = {
    latitude: mapCenter.lat,
    longitude: mapCenter.lng,
    latitudeDelta: INITIAL_DELTA,
    longitudeDelta: INITIAL_DELTA,
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : undefined}
        onPress={() => { Keyboard.dismiss(); setSuggestions([]); }}
        onRegionChangeComplete={(r) => { currentRegionRef.current = r; }}
      >
        {stopMarkers.map(({ stop, coordinate, distanceLabel, onPress }) => {
          const isSelected = selectedStop?.stop_id === stop.stop_id;
          return (
            <Marker
              // Selection is baked into the rasterized dot, so key on it: the
              // marker remounts (redrawing once) when selection flips instead of
              // re-rasterizing continuously (tracksViewChanges stays false).
              key={`stop-${stop.stop_id}-${isSelected ? "selected" : "idle"}`}
              tracksViewChanges={false}
              anchor={{ x: 0.5, y: 0.5 }}
              coordinate={coordinate}
              title={stop.stop_name}
              description={distanceLabel}
              onPress={onPress}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`Bus stop ${stop.stop_name}, ${distanceLabel}${isSelected ? ", selected" : ""}`}
            >
              <StopDot selected={isSelected} />
            </Marker>
          );
        })}
        {selectedPlace && (
          <Marker
            coordinate={{ latitude: selectedPlace.lat, longitude: selectedPlace.lng }}
            title={selectedPlace.name}
            anchor={{ x: 0.5, y: 1.0 }}
            key="dest"
            tracksViewChanges={false}
            // Not tappable — it is a location pin, so it is announced as an
            // image rather than offered as a control that does nothing.
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Destination: ${selectedPlace.name}`}
          >
            <View style={{ alignItems: 'center' }}>
              <View style={{
                width: 22, height: 22, borderRadius: 11,
                backgroundColor: theme.colors.navy,
                borderWidth: 2.5, borderColor: theme.colors.surface,
                shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.3, shadowRadius: 3, elevation: 4,
                justifyContent: 'center', alignItems: 'center',
              }}>
                <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: theme.colors.surface }} />
              </View>
              <View style={{ width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7,
                borderLeftColor: 'transparent', borderRightColor: 'transparent',
                borderTopColor: theme.colors.navy, marginTop: -1 }} />
            </View>
          </Marker>
        )}
        {vehicles.map((v) => {
          const crowding = vehicleCrowding[v.vehicle_id];
          return (
            <VehicleMarker
              // Unchanged strategy, now owned by the marker: the ring colour and
              // the crowding glyph are baked into the bitmap by
              // `tracksViewChanges={false}`, so the only way to redraw them is
              // to remount — which `vehicleMarkerKey` does exactly once, when
              // crowding actually changes. Deliberately NOT a live animation:
              // an animated ring under a rasterized marker renders nothing at
              // all on Android.
              //
              // Heading has dropped out of the key because it now rides the
              // marker's native `rotation` prop, so a turning bus no longer
              // costs a remount — and no longer throws away a glide in flight.
              key={vehicleMarkerKey(v, crowding)}
              vehicle={v}
              crowding={crowding}
              glide={glidingVehicleIds.has(v.vehicle_id)}
              onPress={onVehiclePress}
            />
          );
        })}
        {walkPolylines.map((coords, i) => (
          <React.Fragment key={`walk-frag-${selectedRouteIdx}-${i}`}>
            <Polyline
              key={`walk-outline-${selectedRouteIdx}-${i}`}
              coordinates={coords}
              strokeColor="rgba(255,255,255,0.85)"
              strokeWidth={6}
              lineDashPattern={[8, 6]}
              zIndex={8}
              lineCap={"round" as any}
            />
            <Polyline
              key={`walk-main-${selectedRouteIdx}-${i}`}
              coordinates={coords}
              strokeColor={theme.colors.navy}
              strokeWidth={3}
              lineDashPattern={[8, 6]}
              zIndex={9}
              lineCap={"round" as any}
            />
          </React.Fragment>
        ))}
        {busPolylines.map((coords, i) => (
          <React.Fragment key={`bus-frag-${selectedRouteIdx}-${i}`}>
            <Polyline
              key={`bus-shadow-${selectedRouteIdx}-${i}`}
              coordinates={coords}
              strokeColor="rgba(19,41,75,0.25)"
              strokeWidth={9}
              zIndex={10}
              lineCap={"round" as any}
              lineJoin={"round" as any}
            />
            <Polyline
              key={`bus-main-${selectedRouteIdx}-${i}`}
              coordinates={coords}
              strokeColor={theme.colors.orange}
              strokeWidth={5}
              zIndex={11}
              lineCap={"round" as any}
              lineJoin={"round" as any}
            />
          </React.Fragment>
        ))}
      </MapView>

      {crowdingSheet && (
        <CrowdingSheet
          visible={!!crowdingSheet}
          vehicleId={crowdingSheet.vehicleId}
          routeId={crowdingSheet.routeId}
          onClose={() => setCrowdingSheet(null)}
        />
      )}

      {/* Search bar */}
      {status === "loading" && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color={theme.colors.navy} />
        </View>
      )}
      <View style={styles.searchContainer}>
        <View style={styles.searchRow}>
          <Search size={16} color={theme.colors.textMuted} style={{ marginLeft: 12, marginRight: 4 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search restaurants, buildings, places..."
            placeholderTextColor={theme.colors.textMuted}
            value={mapSearch}
            onChangeText={setMapSearch}
            returnKeyType="search"
            autoCorrect={false}
          />
          {mapSearch.length > 0 && (
            <Pressable
              style={styles.clearBtn}
              onPress={clearSearch}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <X size={14} color={theme.colors.textMuted} />
            </Pressable>
          )}
        </View>
        {suggestions.length > 0 && (
          <ScrollView style={styles.suggestionList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {suggestions.map((r, i) => (
              <Pressable
                key={i}
                style={styles.suggestionRow}
                onPress={() => onSelectSuggestion(r)}
                accessibilityRole="button"
                accessibilityLabel={r.display_name && r.display_name !== r.name ? `${r.name}, ${r.display_name}` : r.name}
              >
                <Text style={styles.suggestionName}>{r.name}</Text>
                {r.display_name && r.display_name !== r.name && (
                  <Text style={styles.suggestionSub} numberOfLines={1}>{r.display_name}</Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>

      {useUiucArea && (
        <View style={styles.uiucBanner}>
          <Text style={styles.uiucBannerText}>Showing UIUC area</Text>
          <Pressable
            onPress={() => { setUseUiucArea(false); loadStops(); }}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Use my location"
          >
            <Text style={styles.uiucBannerLink}>Use my location</Text>
          </Pressable>
        </View>
      )}
      {vehicles.length > 0 && (
        <View style={styles.vehicleLegend}>
          <MapLiveBadge count={vehicles.length} />
        </View>
      )}
      <PressableScale
        style={styles.centerBtn}
        onPress={centerOnMe}
        accessibilityRole="button"
        accessibilityLabel="Center map on my location"
        scaleTo={0.88}
      >
        <MapPin size={20} color={theme.colors.textOnNavy} />
      </PressableScale>

      {/* Zoom controls */}
      <View style={styles.zoomControls}>
        <PressableScale style={styles.zoomBtn} onPress={zoomIn} accessibilityRole="button" accessibilityLabel="Zoom in" scaleTo={0.85}>
          <Text style={styles.zoomBtnText}>+</Text>
        </PressableScale>
        <View style={styles.zoomDivider} />
        <PressableScale style={styles.zoomBtn} onPress={zoomOut} accessibilityRole="button" accessibilityLabel="Zoom out" scaleTo={0.85}>
          <Text style={styles.zoomBtnText}>−</Text>
        </PressableScale>
      </View>

      {/* Place route panel */}
      {selectedPlace && (
        <FadeInView dy={28} duration={theme.motion.base} style={styles.detailCard}>
          <View style={styles.grabber} />
          <View style={styles.detailHeader}>
            <Text style={styles.detailTitle} numberOfLines={1}>{selectedPlace.name}</Text>
            {location && (
              <Text style={styles.detailDistance}>
                {formatDistance(haversineMeters(location.lat, location.lng, selectedPlace.lat, selectedPlace.lng))} away
              </Text>
            )}
          </View>
          {placeRoutesLoading ? (
            <View style={styles.panelSkeletons}>
              <Skeleton height={64} radius={theme.radius.lg} />
              <Skeleton height={64} radius={theme.radius.lg} />
            </View>
          ) : routesError ? (
            // Same scroll container as the list: the panel caps at 300pt, and
            // EmptyState's tall padding could push Retry past that cap on
            // small screens — inside the ScrollView it stays reachable.
            <ScrollView style={styles.routeList} nestedScrollEnabled showsVerticalScrollIndicator={false}>
              <EmptyState
                icon={CloudOff}
                title="Couldn't load routes"
                subtitle="We couldn't reach the server. Check your connection and try again."
                action={{ label: "Retry", onPress: retryPlaceRoutes }}
              />
            </ScrollView>
          ) : placeRoutes.length > 0 ? (
            <ScrollView style={styles.routeList} nestedScrollEnabled showsVerticalScrollIndicator={false}>
              <Stagger step={STAGGER.listStep} cap={STAGGER.listCap} dy={10}>
                {placeRoutes.map((opt, i) => {
                const optionLabel = opt.type === "WALK" ? "Walk" : i === 0 ? "Best option" : "Alternative";
                const optionMeta =
                  opt.type === "WALK"
                    ? `${opt.eta_minutes} min walk`
                    : opt.depart_in_minutes <= 1
                    ? `Leave now · ${opt.eta_minutes} min total`
                    : `Leave in ${opt.depart_in_minutes} min · ${opt.eta_minutes} min total`;
                return (
                    <Pressable
                      key={i}
                      style={[styles.routeRow, selectedRouteIdx === i && styles.routeRowSelected]}
                      onPress={() => setSelectedRouteIdx(i)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: selectedRouteIdx === i }}
                      accessibilityLabel={`${optionLabel}, ${optionMeta}`}
                    >
                      <View style={styles.routeInfo}>
                        <Text style={styles.routeLabel}>{optionLabel}</Text>
                        <Text style={styles.routeMeta}>{optionMeta}</Text>
                        <View style={styles.stepChips}>
                          {opt.steps
                            .filter(s => s.type === 'WALK_TO_STOP' || s.type === 'RIDE' || s.type === 'WALK_TO_DEST')
                            .map((step, si) => (
                              <View key={si} style={[styles.stepChip, step.type === 'RIDE' ? styles.stepChipRide : styles.stepChipWalk]}>
                                {step.type === 'RIDE'
                                  ? <Bus size={10} color={theme.colors.brandInk} />
                                  : <Footprints size={10} color={theme.colors.navy} />}
                                <Text style={[styles.stepChipText, { color: step.type === 'RIDE' ? theme.colors.brandInk : theme.colors.navy }]}>
                                  {step.type === 'RIDE'
                                    ? (step.route_short_name || step.route || 'Bus')
                                    : `${Math.round((step.walk_distance_m || 0) / 80)}m`}
                                </Text>
                              </View>
                            ))}
                        </View>
                      </View>
                      <PressableScale
                        style={styles.startBtn}
                        onPress={() => onStartNavigation(opt)}
                        scaleTo={0.92}
                        accessibilityRole="button"
                        accessibilityLabel={`Start ${opt.type === "WALK" ? "walking" : "bus"} navigation`}
                      >
                        <LinearGradient
                          colors={[theme.gradients.sunset[0], theme.gradients.sunset[1]]}
                          start={{ x: 0, y: 0 }}
                          end={{ x: 1, y: 1 }}
                          style={styles.startBtnFill}
                        >
                          <Text style={styles.startBtnText}>Go</Text>
                        </LinearGradient>
                      </PressableScale>
                    </Pressable>
                );
              })}
              </Stagger>
            </ScrollView>
          ) : (
            <Text style={styles.depEmpty}>No routes available right now.</Text>
          )}
        </FadeInView>
      )}

      {/* Bus stop detail sheet.
          Mounted for the life of the screen and driven by `index` — detent 0
          is closed. Keeping it mounted is what makes a stop tap animate the
          sheet up rather than pop a new surface into place, and it is why the
          departures list can keep rendering while the sheet slides away. */}
      <Sheet
        snapPoints={STOP_SNAP_POINTS}
        index={stopSheetIndex}
        onIndexChange={onStopSheetIndexChange}
        // Declares that the sheet's pan may run alongside the map's own
        // recognizer. NOTE: verified against RNGH 2.28's
        // `convertToHandlerTag` (GestureDetector/utils.js), a ref whose
        // `current` has no `handlerTag` resolves to -1 and is FILTERED OUT —
        // a bare MapView instance is not an RNGH handler, so this currently
        // registers no relation at all. It is kept because it is the correct
        // wiring the moment the map is wrapped in a `Gesture.Native()`
        // detector; it is NOT what keeps the map pannable today. What does is
        // geometry: the sheet's GestureDetector covers only the sheet
        // surface, so touches on the exposed map never reach it.
        simultaneousWithExternalGesture={mapGestureRef}
        accessibilityLabel={sheetStop ? `Departures from ${sheetStop.stop_name}` : "Stop details"}
        contentStyle={styles.sheetContent}
        testID="stop-sheet"
        header={
          sheetStop ? (
            <View style={styles.sheetHeader}>
              <Text style={styles.detailTitle} numberOfLines={2}>{sheetStop.stop_name}</Text>
              <Text style={styles.detailDistance}>{formatDistance(sheetStop.distance_m)} away</Text>
            </View>
          ) : null
        }
      >
        {sheetStop ? (
          <>
            <View style={styles.tripBtnWrap}>
              <Button label="View departures" onPress={() => onOpenTrip(sheetStop)} variant="primary" />
            </View>
            {departuresLoading ? (
              <View style={styles.panelSkeletons}>
                <Skeleton height={44} radius={theme.radius.md} />
                <Skeleton height={44} radius={theme.radius.md} />
              </View>
            ) : sheetDeparturesError ? (
              <EmptyState
                icon={CloudOff}
                title="Couldn't load departures"
                subtitle="We couldn't reach the server. Check your connection and try again."
                action={{ label: "Retry", onPress: () => { refetchDepartures(); } }}
              />
            ) : sheetDepartures.length > 0 ? (
              <ScrollView style={styles.depList} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                {/* `Stagger` replaces the hand-written `delay={i * 45}`: it caps
                    the delay, so row 8 does not wait a third of a second for a
                    list that is already on screen. */}
                <Stagger step={STAGGER.listStep} cap={STAGGER.listCap} dy={8}>
                  {sheetDepartures.slice(0, 8).map((d, i) => (
                    <DepartureRow
                      key={i}
                      route={d.route}
                      headsign={d.headsign || "—"}
                      expectedMins={d.expected_mins}
                      isRealtime={d.is_realtime}
                      expectedTimeIso={d.expected_time_iso}
                      delayStatus={d.delay_status}
                      delayMins={d.delay_mins}
                    />
                  ))}
                </Stagger>
              </ScrollView>
            ) : (
              <Text style={styles.depEmpty}>No departures in the next 60 min.</Text>
            )}
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1, width: "100%", height: "100%" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: theme.spacing.lg + 4, backgroundColor: theme.colors.surfaceAlt },
  errorText: { ...theme.text.heading, fontSize: 18, color: theme.colors.errorDeep },
  hint: { ...theme.text.caption, fontSize: 14, color: theme.colors.textSecondary, marginTop: theme.spacing.sm + 2, textAlign: "center" },
  retryBtn: {
    marginTop: theme.spacing.lg - 4,
    minHeight: theme.layout.tapMin,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg + 4,
    backgroundColor: theme.colors.navy,
    borderRadius: theme.radius.lg,
    ...theme.shadows.glowNavy,
  },
  retryBtnSecondary: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: theme.colors.navy, marginTop: theme.spacing.sm + 2, ...theme.elevation[0] },
  retryBtnText: { ...theme.text.subhead, fontSize: 16, color: theme.colors.textOnNavy },
  retryBtnSecondaryText: { ...theme.text.subhead, color: theme.colors.navy },
  loadingOverlay: {
    position: "absolute",
    top: 70,
    alignSelf: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    padding: theme.spacing.sm + 2,
    zIndex: 10,
    ...theme.elevation[2],
  },
  searchContainer: {
    position: "absolute",
    top: 16,
    left: 16,
    right: 80,
    zIndex: 10,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    paddingLeft: 6,
    ...theme.shadows.lg,
  },
  searchInput: {
    flex: 1,
    height: 48,
    paddingHorizontal: 8,
    fontSize: 15,
    fontFamily: "DMSans_400Regular",
    color: theme.colors.text,
  },
  clearBtn: {
    minWidth: theme.layout.tapMin,
    minHeight: theme.layout.tapMin,
    justifyContent: "center",
    alignItems: "center",
  },
  suggestionList: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    marginTop: 6,
    maxHeight: 220,
    overflow: "hidden",
    ...theme.shadows.lg,
  },
  suggestionRow: {
    minHeight: theme.layout.tapMin,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: theme.spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSoft,
  },
  suggestionName: { ...theme.text.subhead, color: theme.colors.text },
  suggestionSub: { ...theme.text.caption, fontSize: 12, color: theme.colors.textMuted, marginTop: 2 },
  uiucBanner: {
    position: "absolute",
    top: 72,
    left: theme.layout.gutter,
    right: 80,
    backgroundColor: theme.colors.surface,
    paddingVertical: theme.spacing.sm + 2,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 20,
    ...theme.elevation[2],
  },
  uiucBannerText: { ...theme.text.caption, color: theme.colors.textSecondary },
  uiucBannerLink: { ...theme.text.subhead, fontSize: 13, color: theme.colors.brandInk },
  vehicleLegend: {
    position: "absolute",
    top: 116,
    left: theme.layout.gutter,
    zIndex: 19,
  },
  fallbackTitle: { fontSize: 20, fontFamily: "DMSans_700Bold", color: theme.colors.navy, marginBottom: 8 },
  fallbackText: { fontSize: 16, fontFamily: "DMSans_400Regular", color: theme.colors.text, textAlign: "center" },
  fallbackHint: { fontSize: 14, fontFamily: "DMSans_400Regular", color: theme.colors.textSecondary, marginTop: 12, textAlign: "center" },
  centerBtn: {
    position: "absolute",
    top: 16,
    right: 16,
    backgroundColor: theme.colors.navy,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadows.glowNavy,
  },
  zoomControls: {
    position: "absolute",
    top: 76,
    right: 16,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    ...theme.shadows.lg,
  },
  zoomBtn: {
    width: 48,
    height: 44,
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
  detailCard: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xxl,
    borderTopRightRadius: theme.radius.xxl,
    padding: 16,
    paddingTop: 18,
    maxHeight: 300,
    shadowColor: "#0B1B36",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 10,
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
    marginTop: -6,
    marginBottom: 10,
  },
  detailHeader: { marginBottom: 10 },
  detailTitle: { ...theme.text.title2, fontSize: 20, lineHeight: 26, color: theme.colors.navy },
  detailDistance: { ...theme.text.caption, fontSize: 13, color: theme.colors.textMuted, marginTop: 4, fontVariant: ["tabular-nums"] },
  routeList: { maxHeight: 220 },
  routeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: theme.layout.tapMin,
    paddingVertical: theme.spacing.md - 2,
    paddingHorizontal: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSoft,
    borderRadius: theme.radius.md,
  },
  routeRowSelected: {
    backgroundColor: theme.colors.orangeSoft,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.orange,
  },
  routeInfo: { flex: 1, marginRight: theme.spacing.md },
  routeLabel: { ...theme.text.subhead, color: theme.colors.navy },
  routeMeta: { ...theme.text.caption, color: theme.colors.textSecondary, marginTop: 2, fontVariant: ["tabular-nums"] },
  stepChips: { flexDirection: "row", gap: 4, marginTop: 5, flexWrap: "wrap" },
  stepChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: theme.radius.pill,
  },
  stepChipRide: { backgroundColor: theme.colors.orangeSoft },
  stepChipWalk: { backgroundColor: theme.colors.borderSoft },
  stepChipText: { ...theme.text.badge, fontSize: 11, fontVariant: ["tabular-nums"] },
  startBtn: {
    minWidth: theme.layout.tapMin,
    minHeight: theme.layout.tapMin,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    ...theme.shadows.glowOrange,
  },
  startBtnFill: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing.sm + 3,
    paddingHorizontal: theme.spacing.lg - 2,
  },
  startBtnText: { ...theme.text.subhead, color: theme.colors.surface },
  tripBtnWrap: { marginBottom: theme.layout.cardGap },
  panelSkeletons: { gap: theme.spacing.sm + 2, marginVertical: theme.spacing.sm + 2 },
  // The Sheet gives its content a flex:1 box sized to the tallest detent, so
  // the padding that used to live on `detailCard` belongs here instead.
  sheetHeader: { paddingHorizontal: theme.layout.gutter, marginBottom: 10 },
  sheetContent: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.spacing.lg },
  // Fills the sheet rather than a fixed 150pt window: at the 0.85 detent the
  // whole board is readable, at 0.45 the same list scrolls in a shorter frame.
  depList: { flex: 1 },
  depEmpty: { ...theme.text.caption, fontSize: 14, color: theme.colors.textMuted, fontStyle: "italic", marginTop: theme.spacing.sm + 2 },
});

// The vehicle puck's geometry moved to `VehicleMarker` with the marker itself.
const markerStyles = StyleSheet.create({
  // Transparent 44pt tap target around the dot; the marker is anchored at its
  // centre, so the visible dot does not move.
  stopTapTarget: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  stopIdle: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.navy,
    borderWidth: 2,
    borderColor: theme.colors.surface,
  },
  stopSelectedOuter: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.navy,
    borderWidth: 3,
    borderColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
    ...theme.elevation[2],
  },
  stopSelectedInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.orange },
});
