import { departureKeys } from "../departureKey";

const dep = (route: string, iso: string | null, mins = 5) => ({
  route,
  headsign: "Illini",
  expected_time_iso: iso,
  expected_mins: mins,
});

describe("departureKeys", () => {
  it("keys a bus by identity, so it keeps its key when the list shifts", () => {
    const a = dep("22", "2026-10-02T10:05:00-05:00");
    const b = dep("22", "2026-10-02T10:15:00-05:00");
    const [, keyB] = departureKeys([a, b]);
    expect(departureKeys([b])[0]).toBe(keyB);
  });

  it("keeps keys unique for duplicate entries", () => {
    const keys = departureKeys([dep("1", null, 3), dep("1", null, 3), dep("1", null, 3)]);
    expect(new Set(keys).size).toBe(3);
  });

  it("falls back to minutes-away when there is no timestamp", () => {
    expect(departureKeys([dep("5", null, 7)])[0]).toBe("5|Illini|+7");
  });
});
