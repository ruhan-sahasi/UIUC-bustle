import { formatOptionLabel, buildRouteSummary } from "@/src/utils/routeFormatting";
import type { RecommendationOption } from "@/src/api/types";

const walk: RecommendationOption = {
  type: "WALK",
  eta_minutes: 12.4,
  depart_in_minutes: 0,
  summary: "",
  steps: [{ type: "WALK_TO_DEST" } as any],
};

const bus: RecommendationOption = {
  type: "BUS",
  eta_minutes: 8.6,
  depart_in_minutes: 3,
  summary: "",
  steps: [
    { type: "WALK_TO_STOP" } as any,
    { type: "RIDE", route: "22" } as any,
    { type: "WALK_TO_DEST" } as any,
  ],
};

describe("formatOptionLabel", () => {
  it("labels and rounds a walk option", () => {
    expect(formatOptionLabel(walk)).toBe("Walk (12 min)");
  });

  it("includes the route number for a bus option", () => {
    expect(formatOptionLabel(bus)).toBe("Bus 22 (9 min)");
  });

  it("falls back when a bus option has no route on any step", () => {
    const noRoute = { ...bus, steps: [{ type: "RIDE" } as any] };
    expect(formatOptionLabel(noRoute)).toBe("Bus (9 min)");
  });
});

describe("buildRouteSummary", () => {
  it("joins bus and walk options with OR", () => {
    expect(buildRouteSummary([bus, walk])).toBe("Bus 22 in 3 min OR walk 12 min");
  });

  it("returns just the walk part when no bus option exists", () => {
    expect(buildRouteSummary([walk])).toBe("walk 12 min");
  });

  it("returns an empty string for no options", () => {
    expect(buildRouteSummary([])).toBe("");
  });
});
