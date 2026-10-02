import { formatDistance, haversineMeters } from "@/src/utils/distance";

describe("formatDistance", () => {
  it("shows feet below the 528 ft threshold", () => {
    expect(formatDistance(0)).toBe("0 ft");
    expect(formatDistance(100)).toBe("328 ft"); // 100 m ≈ 328.084 ft
  });

  it("switches to miles at/above the threshold", () => {
    // 528 ft ≈ 160.93 m
    expect(formatDistance(161)).toMatch(/mi$/);
    expect(formatDistance(1609.344)).toBe("1.0 mi");
    expect(formatDistance(3218.688)).toBe("2.0 mi");
  });

  it("never renders NaN or a negative distance", () => {
    expect(formatDistance(NaN)).toBe("—");
    expect(formatDistance(Infinity)).toBe("—");
    expect(formatDistance(-5)).toBe("0 ft");
  });
});

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters(40.1, -88.2, 40.1, -88.2)).toBe(0);
  });

  it("approximates a known short distance", () => {
    // Two points ~1 km apart in latitude (0.009°) near UIUC.
    const d = haversineMeters(40.10, -88.22, 40.109, -88.22);
    expect(d).toBeGreaterThan(950);
    expect(d).toBeLessThan(1050);
  });

  it("is symmetric", () => {
    const a = haversineMeters(40.1, -88.2, 40.2, -88.3);
    const b = haversineMeters(40.2, -88.3, 40.1, -88.2);
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
  });
});
