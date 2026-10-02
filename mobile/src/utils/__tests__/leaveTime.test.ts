import { clockTimeAfter, clockTimeBefore, minutesUntilBefore, padTime } from "../leaveTime";

describe("leaveTime", () => {
  const nineAm = new Date(2026, 9, 2, 9, 0, 0);

  it("pads hours and minutes", () => {
    expect(padTime(7, 5)).toBe("07:05");
  });

  it("clockTimeAfter counts forward from now (API depart_in_minutes)", () => {
    // 10:00 class, fetched at 9:00 with depart_in = 25 → leave at 9:25, not 9:35.
    expect(clockTimeAfter(nineAm, 25)).toBe("09:25");
    expect(clockTimeAfter(nineAm, 24.6)).toBe("09:25");
    expect(clockTimeAfter(new Date(2026, 9, 2, 23, 50), 15)).toBe("00:05");
  });

  it("clockTimeBefore counts back from the class start (fallback estimate)", () => {
    expect(clockTimeBefore("10:00", 15)).toBe("09:45");
    expect(clockTimeBefore("00:10", 15)).toBe("23:55");
    expect(clockTimeBefore("garbage", 0)).toBe("00:00");
  });

  it("minutesUntilBefore is relative to now", () => {
    expect(minutesUntilBefore("10:00", 15, nineAm)).toBe(45);
    expect(minutesUntilBefore("09:10", 15, nineAm)).toBe(-5);
  });
});
