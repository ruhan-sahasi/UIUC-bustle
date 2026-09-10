/**
 * VehicleMarker — the live bus puck on the map.
 *
 * Before this component, buses TELEPORTED: `useVehicles` polls every 15s and
 * each response moved a plain <Marker> to a new coordinate in one frame. This
 * component eases between consecutive GPS fixes and turns the puck to face the
 * way the bus is actually driving.
 *
 * ── Why AnimatedRegion and not animateMarkerToCoordinate ──────────────────
 * `Marker.animateMarkerToCoordinate` is ANDROID-ONLY (it exists in
 * MapMarkerManager.java and has no iOS counterpart in react-native-maps
 * 1.20.1). The only cross-platform glide is <MarkerAnimated> fed by an
 * AnimatedRegion, so that is what this uses.
 *
 * ── Why glide is a prop, and why the caller should cap it ─────────────────
 * AnimatedRegion runs on `useNativeDriver: false` — there is no native driver
 * for a map coordinate. Every gliding marker therefore costs JS-thread frames
 * for `GLIDE.vehicle` ms after each poll. Forty concurrent glides is forty JS
 * drivers firing at once every 15 seconds. `glide={false}` SNAPS instead, so
 * the screen can glide the handful of buses in view and snap the rest.
 *
 * ── Why the heading is a native prop and not a child transform ────────────
 * `tracksViewChanges={false}` means the marker's children are rasterized ONCE
 * into a bitmap; a `transform: [{ rotate }]` on a child after that point is
 * simply not drawn on Android. Heading must go through the marker's own
 * `rotation` prop (with `flat`, so the puck lies in the map plane and stays
 * true to the compass when the user rotates the map).
 *
 * Rotation is accumulated through `shortestAngleDelta`, so a bus crossing due
 * north turns 350 -> 10 as a +20 degree nudge instead of unwinding -340
 * degrees the long way round the dial.
 *
 * ── Why crowding is NOT animated ──────────────────────────────────────────
 * Same bitmap rule: the ring color and the crowding glyph are baked in at
 * raster time. map.tsx already solves this by putting the ring color in the
 * marker's React `key`, so a crowding change remounts the marker and redraws
 * the bitmap exactly once. That strategy is preserved — see
 * `vehicleMarkerKey`, which is the key the caller should use. Converting the
 * ring into a live animation would silently render nothing on Android.
 */
import type { CrowdingInfo, CrowdingLevel, VehicleInfo } from "@/src/api/types";
import { GLIDE } from "@/src/constants/motion";
import { theme } from "@/src/constants/theme";
import { fireHaptic, useReducedMotion } from "@/src/components/ui/motion";
import { bearingDeg, normalizeDeg, shortestAngleDelta } from "@/src/lib/geo";
import { crowdingColor, crowdingGlyph } from "@/src/utils/crowding";
import { haversineMeters } from "@/src/utils/distance";
import type { LucideIcon } from "lucide-react-native";
import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, View } from "react-native";
import { AnimatedRegion, Marker, MarkerAnimated } from "react-native-maps";
import type { LatLng } from "react-native-maps";

/**
 * react-native-maps is stubbed out on web (see metro.config.js): the stub
 * exports `Marker` but neither `MarkerAnimated` nor `AnimatedRegion`, and
 * animated coordinates have no meaning there anyway. On web we render the
 * finished static state and never construct an AnimatedRegion.
 */
const IS_WEB = Platform.OS === "web";

/** Below this, the "movement" is GPS jitter — the puck is already there. */
const MIN_GLIDE_METERS = 1;
/**
 * Above this, it is not a bus moving: it is a glitched fix or a vehicle_id
 * reassigned to another coach. 15s of highway driving is ~400m, so 750m can
 * only be a jump — glide it and the puck sails across campus through
 * buildings. Snap instead.
 */
const MAX_GLIDE_METERS = 750;
/** Turns smaller than this are noise; snap the rotation rather than animate it. */
const MIN_TURN_DEGREES = 2;
/** A bearing derived from two fixes closer than this is meaningless. */
const MIN_BEARING_METERS = 4;

/** `AnimatedRegion#timing` takes `TimingAnimationConfig & Region`. */
type MapAnimatedRegion = InstanceType<typeof AnimatedRegion>;
type RegionTimingConfig = Parameters<MapAnimatedRegion["timing"]>[0];

/**
 * Animate only latitude/longitude.
 *
 * `AnimatedRegion#timing` builds one `Animated.timing` per key PRESENT in the
 * config (`hasOwnProperty`), so passing the deltas we do not care about would
 * double the number of JS-thread drivers per marker for two values that are
 * pinned at 0. The published type demands a full `Region` plus a `toValue`
 * (which the method overwrites itself), hence the cast — it narrows the work,
 * it does not widen it.
 */
function regionTiming(
  region: MapAnimatedRegion,
  latitude: number,
  longitude: number,
  duration: number
): Animated.CompositeAnimation {
  return region.timing({
    latitude,
    longitude,
    duration,
    easing: Easing.inOut(Easing.quad),
    useNativeDriver: false,
  } as unknown as RegionTimingConfig);
}

/**
 * `AnimatedRegion#setValue` writes `_value` straight onto the inner
 * Animated.Values and never flushes them to the view, so a marker snapped
 * that way keeps drawing at its old coordinate. A zero-duration timing takes
 * RN's documented immediate path (`TimingAnimation` short-circuits when
 * `duration === 0`) and actually reaches the native marker.
 */
function snapRegion(region: MapAnimatedRegion, latitude: number, longitude: number): void {
  regionTiming(region, latitude, longitude, 0).start();
}

/**
 * Spoken crowding, not badge copy. VoiceOver reads the label as a sentence, so
 * "Standing" (a fine badge word) lands as an instruction; "standing room" is a
 * description. This is what pairs the ring COLOR with WORDS — the color alone
 * never carries the status.
 */
const CROWDING_SPEECH: Record<CrowdingLevel, string> = {
  1: "empty",
  2: "some seats",
  3: "standing room",
  4: "full",
};

/** e.g. "Route 22 bus to Illinois Terminal, standing room, estimated". */
function vehicleLabel(vehicle: VehicleInfo, crowding: CrowdingInfo | null | undefined): string {
  const route = `Route ${vehicle.route_id} bus`;
  const to = vehicle.headsign ? ` to ${vehicle.headsign}` : "";
  if (!crowding) return `${route}${to}, crowding unknown`;
  const level = CROWDING_SPEECH[crowding.level] ?? "crowding unknown";
  const estimated = crowding.source === "estimated" ? ", estimated" : "";
  return `${route}${to}, ${level}${estimated}`;
}

/**
 * The React `key` a caller must give this marker.
 *
 * Everything in it is baked into the marker bitmap by
 * `tracksViewChanges={false}`, so the only way to redraw it is to remount —
 * which this key does, exactly once, when the crowding actually changes.
 *
 * Heading is deliberately ABSENT: it now rides the native `rotation` prop, so
 * unlike the pre-motion map.tsx (which re-keyed on a 30-degree heading bucket)
 * a turning bus no longer costs a remount, and the glide it is in the middle
 * of survives the turn.
 */
export function vehicleMarkerKey(
  vehicle: VehicleInfo,
  crowding?: CrowdingInfo | null
): string {
  const info = crowding ?? vehicle.crowding ?? null;
  return `vehicle-${vehicle.vehicle_id}-${crowdingColor(info)}-${info?.level ?? "none"}`;
}

/**
 * The rasterized face: orange puck, heading wedge, crowding ring + glyph.
 * Pure render, no animation — see the file header for why.
 *
 * The whole face rotates with the marker, which is fine because every part of
 * it is radially symmetric: a ring, a round core, and a circular crowding
 * glyph. Only the wedge is meant to read as directional.
 *
 * The wedge is drawn unconditionally, unlike the pre-motion map.tsx which hid
 * it when `heading` was missing. Hiding it now would have to be baked into the
 * bitmap, which means baking it into `vehicleMarkerKey`, which means a feed
 * that drops `heading` for a single poll remounts every marker and kills every
 * glide in flight. A vehicle with no heading and no previous fix points north
 * for one poll instead; the bearing fallback fixes it as soon as it moves.
 */
function VehicleFace({ ringColor, Glyph }: { ringColor: string; Glyph: LucideIcon | null }) {
  return (
    <View style={styles.vehicleWrap}>
      <View style={styles.headingLayer}>
        <View style={styles.headingWedge} />
      </View>
      <View style={[styles.vehicleDot, { borderColor: ringColor }]}>
        <View style={styles.vehicleCore} />
      </View>
      {Glyph != null && (
        <View style={styles.crowdBubble}>
          <Glyph size={10} color={ringColor} strokeWidth={2.6} />
        </View>
      )}
    </View>
  );
}

export interface VehicleMarkerProps {
  /** One live vehicle from `GET /vehicles`. */
  vehicle: VehicleInfo;
  /** Crowding for this vehicle; falls back to `vehicle.crowding`. */
  crowding?: CrowdingInfo | null;
  /**
   * Ease between fixes (default true). Pass false to SNAP — each glide is a
   * non-native-driver animation, so the screen should cap how many run at once
   * (buses in view glide, the rest snap).
   */
  glide?: boolean;
  onPress?: (vehicle: VehicleInfo) => void;
}

function VehicleMarkerImpl({ vehicle, crowding, glide = true, onPress }: VehicleMarkerProps) {
  const info = crowding ?? vehicle.crowding ?? null;
  const ringColor = crowdingColor(info);
  const Glyph = info ? crowdingGlyph(info) : null;
  const label = vehicleLabel(vehicle, info);

  const reducedMotion = useReducedMotion();
  // Reduced motion is honored here in JS because AnimatedRegion is RN Animated,
  // not Reanimated: it has no ReduceMotion.System to obey.
  const animate = glide && !reducedMotion && !IS_WEB;

  const hasFix = Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lng);
  const initialDeg = Number.isFinite(vehicle.heading) ? normalizeDeg(vehicle.heading) : 0;

  // ── One AnimatedRegion for the life of the marker ───────────────────────
  // Rebuilding it on a render would restart the next glide from a stale
  // coordinate (the puck would jump back, then slide forward again).
  const regionRef = useRef<MapAnimatedRegion | null>(null);
  const rotationRef = useRef<Animated.Value | null>(null);
  const lastFixRef = useRef<LatLng | null>(null);
  /** Continuous (possibly unwrapped) rotation the puck is heading toward. */
  const headingDegRef = useRef(initialDeg);
  const posAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const rotAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  if (rotationRef.current === null) {
    rotationRef.current = new Animated.Value(initialDeg);
  }
  if (regionRef.current === null && !IS_WEB && hasFix) {
    regionRef.current = new AnimatedRegion({
      latitude: vehicle.lat,
      longitude: vehicle.lng,
      latitudeDelta: 0,
      longitudeDelta: 0,
    });
    lastFixRef.current = { latitude: vehicle.lat, longitude: vehicle.lng };
  }
  const region = regionRef.current;
  const rotation = rotationRef.current;

  useEffect(() => {
    const lat = vehicle.lat;
    const lng = vehicle.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const prev = lastFixRef.current;
    const movedM = prev ? haversineMeters(prev.latitude, prev.longitude, lat, lng) : 0;

    // ── Heading, before `prev` is overwritten ─────────────────────────────
    // Feed heading wins; a bearing between two fixes is the fallback when the
    // feed omits it or sends NaN/Infinity.
    let targetDeg: number | null = Number.isFinite(vehicle.heading)
      ? normalizeDeg(vehicle.heading)
      : null;
    if (targetDeg === null && prev && movedM >= MIN_BEARING_METERS) {
      targetDeg = bearingDeg(prev, { latitude: lat, longitude: lng });
    }
    if (targetDeg !== null) {
      // Re-wrap first: `from` and `normalizeDeg(from)` are the same angle on
      // screen, so this is invisible, and it keeps the accumulated value from
      // drifting toward five figures over a long session.
      const from = normalizeDeg(headingDegRef.current);
      if (from !== headingDegRef.current) rotation.setValue(from);
      const delta = shortestAngleDelta(from, targetDeg);
      const to = from + delta;
      headingDegRef.current = to;
      if (animate && Math.abs(delta) >= MIN_TURN_DEGREES) {
        rotAnimRef.current?.stop();
        const anim = Animated.timing(rotation, {
          toValue: to,
          duration: GLIDE.vehicle,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        });
        rotAnimRef.current = anim;
        anim.start();
      } else {
        rotAnimRef.current?.stop();
        rotAnimRef.current = null;
        rotation.setValue(to);
      }
    }

    // ── Position ──────────────────────────────────────────────────────────
    if (region) {
      if (!prev) {
        snapRegion(region, lat, lng);
      } else if (movedM >= MIN_GLIDE_METERS) {
        posAnimRef.current?.stop();
        if (animate && movedM <= MAX_GLIDE_METERS) {
          const anim = regionTiming(region, lat, lng, GLIDE.vehicle);
          posAnimRef.current = anim;
          anim.start();
        } else {
          posAnimRef.current = null;
          snapRegion(region, lat, lng);
        }
      } else {
        // Jitter. The puck already sits there; doing nothing is both cheaper
        // and steadier than snapping it a few cm.
        //
        // Bail out BEFORE re-baselining `lastFixRef`: it has to keep pointing
        // at the coordinate the puck is actually DRAWN at, not at the newest
        // reported one. Re-baselining here would throw away each sub-threshold
        // step, so a bus creeping in traffic (or one-directional GPS bias)
        // could travel any distance in 0.9m increments while the puck never
        // once crosses the threshold and never moves. Pinning the baseline
        // makes those steps accumulate until they add up to a real move, and
        // it lengthens the bearing baseline too.
        return;
      }
    }
    lastFixRef.current = { latitude: lat, longitude: lng };
  }, [vehicle.lat, vehicle.lng, vehicle.heading, animate, region, rotation]);

  // Markers unmount constantly (panning, remount-on-crowding, vehicles
  // dropping out of the feed). Leave nothing driving frames behind.
  useEffect(
    () => () => {
      posAnimRef.current?.stop();
      rotAnimRef.current?.stop();
      posAnimRef.current = null;
      rotAnimRef.current = null;
      regionRef.current?.stopAnimation(() => {});
      rotationRef.current?.stopAnimation();
    },
    []
  );

  const handlePress = useCallback(() => {
    fireHaptic("tap");
    onPress?.(vehicle);
  }, [onPress, vehicle]);

  const staticCoordinate = useMemo(
    () => ({ latitude: vehicle.lat, longitude: vehicle.lng }),
    [vehicle.lat, vehicle.lng]
  );

  if (!hasFix) return null;

  const shared = {
    anchor: { x: 0.5, y: 0.5 },
    flat: true,
    tracksViewChanges: false,
    title: `Bus ${vehicle.route_id}`,
    description: vehicle.headsign || undefined,
    onPress: handlePress,
    accessible: true,
    accessibilityRole: "button" as const,
    accessibilityLabel: label,
  };

  // Web: no animated coordinate, no AnimatedRegion — the finished state.
  if (IS_WEB || region === null) {
    // `headingDegRef` is written by the effect, i.e. AFTER this render, and a
    // ref write does not re-render — so reading it alone would draw one poll
    // behind forever. This render's own props are the fresher source whenever
    // the feed carries a heading; the ref is only the fallback for a feed that
    // does not (where the accumulated bearing is all there is).
    const staticRotation = Number.isFinite(vehicle.heading)
      ? normalizeDeg(vehicle.heading)
      : normalizeDeg(headingDegRef.current);
    return (
      <Marker {...shared} coordinate={staticCoordinate} rotation={staticRotation}>
        <VehicleFace ringColor={ringColor} Glyph={Glyph} />
      </Marker>
    );
  }

  return (
    <MarkerAnimated
      {...shared}
      // AnimatedRegion is the value this prop is built for; its class type just
      // does not declare the per-axis Animated.Values the prop type describes.
      coordinate={region as unknown as LatLng}
      rotation={rotation}
    >
      <VehicleFace ringColor={ringColor} Glyph={Glyph} />
    </MarkerAnimated>
  );
}

/**
 * Live bus puck: glides between GPS fixes and faces its heading.
 *
 * Give it the `vehicleMarkerKey` as its React key.
 */
export const VehicleMarker = memo(VehicleMarkerImpl);
VehicleMarker.displayName = "VehicleMarker";

export default VehicleMarker;

/** Geometry copied from map.tsx so the puck is pixel-identical to today's. */
const styles = StyleSheet.create({
  // 44x44 keeps the tap target at the accessibility minimum.
  vehicleWrap: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headingLayer: { position: "absolute", width: 44, height: 44, alignItems: "center" },
  headingWedge: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 8,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: theme.colors.navy,
  },
  vehicleDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 3,
    backgroundColor: theme.colors.orange,
    alignItems: "center",
    justifyContent: "center",
    ...theme.elevation[1],
  },
  vehicleCore: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.surface },
  crowdBubble: {
    position: "absolute",
    right: 2,
    bottom: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
});
