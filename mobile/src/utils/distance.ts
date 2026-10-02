/**
 * Format a distance in meters for display in imperial units.
 * < 528 ft  → "X ft"
 * ≥ 528 ft  → "X.X mi"
 * Non-finite input (a missing GPS fix) → "—" rather than "NaN mi".
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  const feet = Math.max(0, meters) * 3.28084;
  if (feet < 528) {
    return `${Math.round(feet)} ft`;
  }
  const miles = meters / 1609.344;
  return `${miles.toFixed(1)} mi`;
}

/** Haversine distance in meters between two points (lat/lng in degrees). */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
