import type { RecommendationOption } from "@/src/api/types";

export function formatOptionLabel(o: RecommendationOption): string {
  if (o.type === "WALK") return `Walk (${Math.round(o.eta_minutes)} min)`;
  const route = o.steps.find((s) => s.route)?.route;
  return route ? `Bus ${route} (${Math.round(o.eta_minutes)} min)` : `Bus (${Math.round(o.eta_minutes)} min)`;
}

export function buildRouteSummary(options: RecommendationOption[]): string {
  const bus = options.find((o) => o.type === "BUS");
  const walk = options.find((o) => o.type === "WALK");
  const parts: string[] = [];
  if (bus) {
    const rideStep = bus.steps.find((s) => s.type === "RIDE");
    const route = rideStep?.route ?? "Bus";
    // The API returns one-decimal floats; show whole minutes like the rest
    // of the UI (this string ends up in notification bodies).
    parts.push(`Bus ${route} in ${Math.round(bus.depart_in_minutes)} min`);
  }
  if (walk) parts.push(`walk ${Math.round(walk.eta_minutes)} min`);
  return parts.join(" OR ");
}
