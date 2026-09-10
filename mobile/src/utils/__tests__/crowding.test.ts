import {
  CROWD_ESTIMATED_GLYPH,
  CROWD_GLYPHS,
  crowdingColor,
  crowdingGlyph,
  crowdingLabel,
  crowdingSourceLabel,
  isEstimatedCrowding,
} from "@/src/utils/crowding";
import { theme } from "@/src/constants/theme";
import type { CrowdingInfo } from "@/src/api/types";

const crowdsourced = (level: number, report_count = 3): CrowdingInfo =>
  ({ level, source: "crowdsourced", report_count } as CrowdingInfo);

const estimated = (level: number): CrowdingInfo =>
  ({ level, source: "estimated" } as CrowdingInfo);

describe("crowdingColor", () => {
  it("reads the theme's AA crowd scale for observed levels", () => {
    expect(crowdingColor(crowdsourced(1))).toBe(theme.colors.crowd[1]);
    expect(crowdingColor(crowdsourced(4))).toBe(theme.colors.crowd[4]);
  });

  it("falls back to the estimated colour when info is missing or estimated", () => {
    expect(crowdingColor(null)).toBe(theme.colors.crowd.estimated);
    expect(crowdingColor(undefined)).toBe(theme.colors.crowd.estimated);
    // An estimated reading carries a level, but it is a guess: it must NOT
    // wear the level's colour.
    expect(crowdingColor(estimated(3))).toBe(theme.colors.crowd.estimated);
  });

  it("falls back to the estimated colour for a level the scale does not know", () => {
    expect(crowdingColor(crowdsourced(9))).toBe(theme.colors.crowd.estimated);
  });
});

describe("crowdingGlyph", () => {
  it("maps observed levels to their silhouette", () => {
    expect(crowdingGlyph(crowdsourced(1))).toBe(CROWD_GLYPHS[1]);
    expect(crowdingGlyph(crowdsourced(4))).toBe(CROWD_GLYPHS[4]);
  });

  it("uses the slashed ring for missing or estimated readings", () => {
    expect(crowdingGlyph(null)).toBe(CROWD_ESTIMATED_GLYPH);
    expect(crowdingGlyph(estimated(2))).toBe(CROWD_ESTIMATED_GLYPH);
  });

  it("never collides the estimated glyph with a real level's", () => {
    for (const glyph of Object.values(CROWD_GLYPHS)) {
      expect(glyph).not.toBe(CROWD_ESTIMATED_GLYPH);
    }
  });
});

describe("isEstimatedCrowding", () => {
  it("treats null, undefined, and estimated source as estimated", () => {
    expect(isEstimatedCrowding(null)).toBe(true);
    expect(isEstimatedCrowding(undefined)).toBe(true);
    expect(isEstimatedCrowding(estimated(2))).toBe(true);
    expect(isEstimatedCrowding(crowdsourced(2))).toBe(false);
  });
});

describe("crowdingLabel", () => {
  it("returns 'No data' when info is missing", () => {
    expect(crowdingLabel(null)).toBe("No data");
  });

  it("labels known levels", () => {
    expect(crowdingLabel(crowdsourced(1))).toBe("Empty");
    expect(crowdingLabel(crowdsourced(3))).toBe("Standing");
  });
});

describe("crowdingSourceLabel", () => {
  it("singularizes a single report", () => {
    expect(crowdingSourceLabel(crowdsourced(2, 1))).toBe("Based on 1 recent report");
  });

  it("pluralizes multiple reports", () => {
    expect(crowdingSourceLabel(crowdsourced(2, 5))).toBe("Based on 5 recent reports");
  });

  it("describes estimated source", () => {
    expect(crowdingSourceLabel(estimated(2))).toBe("Estimated based on schedule");
  });
});
