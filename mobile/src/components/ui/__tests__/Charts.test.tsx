/**
 * Chart-primitive geometry tests — the degenerate series a live campus feed
 * actually produces (a week of zero steps, a flat crowding line) and the
 * goal-line placement rules that keep BarRow's annotation inside its own plot.
 *
 * These are geometry assertions, not animation assertions: jest never advances
 * an animation clock, so what is pinned here is the SHAPE each chart commits
 * to on its first frame — path y-coordinates, axis scaling, absolute offsets.
 */
import { render, type RenderResult } from "@testing-library/react-native";
import React from "react";
import { StyleSheet } from "react-native";
import { Path } from "react-native-svg";
import { AreaSpark, BarRow, type BarDatum } from "../Charts";

type TestNode = { type: unknown; props: Record<string, unknown> };

/** All y coordinates in an SVG path string's "x,y" pairs. */
function pathYs(d: string): number[] {
  const ys: number[] = [];
  for (const match of d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
    ys.push(Number(match[2]));
  }
  return ys;
}

/** The stroke path (fill "none") AreaSpark draws for the curve itself. */
function strokePathD(tree: RenderResult): string {
  const paths: TestNode[] = tree.UNSAFE_root.findAllByType(Path as never);
  const stroke = paths.find((p) => p.props.fill === "none" && typeof p.props.d === "string");
  expect(stroke).toBeDefined();
  return stroke!.props.d as string;
}

describe("AreaSpark with a degenerate (flat) series", () => {
  // width 100 / height 40 / strokeWidth 2 → pad 2, innerH 36. The contract
  // for a zero-span series is the BASELINE: y = pad + innerH = 38. A flat
  // line across the TOP would read "maxed out"; anywhere above the baseline
  // draws a filled band that overstates an all-zero week.
  const W = 100;
  const H = 40;
  const SW = 2;
  const PAD = SW / 2 + 1;
  const BASELINE_Y = PAD + (H - PAD * 2);
  const TOP_Y = PAD;

  it.each([
    ["an all-zero series", [0, 0, 0, 0]],
    ["an all-equal non-zero series", [5, 5, 5, 5]],
  ])("pins %s to the baseline — never the top edge", (_name, values) => {
    const tree = render(
      <AreaSpark values={values as number[]} width={W} height={H} strokeWidth={SW} />
    );
    const ys = pathYs(strokePathD(tree));
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) {
      expect(y).toBeCloseTo(BASELINE_Y, 1);
      expect(y).toBeGreaterThan(TOP_Y);
    }
  });

  it("positions a flat series by a caller-supplied domain instead of pinning it", () => {
    // An explicit min/max keeps the span non-zero, so a constant series sits
    // at its true place on that scale (5 on [0, 10] → the vertical centre).
    const tree = render(
      <AreaSpark values={[5, 5, 5, 5]} width={W} height={H} strokeWidth={SW} min={0} max={10} />
    );
    const ys = pathYs(strokePathD(tree));
    const MID_Y = PAD + 0.5 * (H - PAD * 2);
    for (const y of ys) expect(y).toBeCloseTo(MID_Y, 1);
  });

  it("keeps a genuinely varying series off the flat-baseline path", () => {
    const tree = render(
      <AreaSpark values={[0, 10, 0, 10]} width={W} height={H} strokeWidth={SW} />
    );
    const ys = pathYs(strokePathD(tree));
    // Positive control: with real span, the curve uses the full inner height,
    // so at least one point sits well above the baseline.
    expect(ys.some((y) => y < BASELINE_Y - 5)).toBe(true);
  });
});

describe("BarRow goal line placement", () => {
  const HEIGHT = 120;

  function zeroWeek(): BarDatum[] {
    return ["M", "T", "W", "T2", "F", "S", "S2"].map((label) => ({ value: 0, label }));
  }

  /** Host nodes positioned absolutely with a numeric `bottom` (the goal wrap). */
  function absoluteBottomNodes(tree: RenderResult): TestNode[] {
    return tree.UNSAFE_root.findAll((node: TestNode) => {
      // Host nodes only — the composite <View> and its host output would
      // otherwise both match and double-count the one goal wrapper.
      if (typeof node.type !== "string") return false;
      if (!node.props || node.props.style == null) return false;
      const flat = StyleSheet.flatten(node.props.style as never) as
        | { position?: string; bottom?: unknown }
        | undefined;
      return flat?.position === "absolute" && typeof flat?.bottom === "number";
    });
  }

  /** The absolute `bottom` offset of the goal-line wrapper. */
  function goalBottom(tree: RenderResult): number {
    const nodes = absoluteBottomNodes(tree);
    expect(nodes.length).toBe(1);
    const flat = StyleSheet.flatten(nodes[0].props.style as never) as { bottom: number };
    return flat.bottom;
  }

  it("keeps the goal inside the plot when the goal tops every bar (all-zero week)", () => {
    // The on-device failure: all bars at zero, goal 10,000 → the goal used to
    // land at bottom === height, i.e. its line and label rendered entirely
    // ABOVE the plot, through the chart's own title.
    const tree = render(<BarRow data={zeroWeek()} height={HEIGHT} goal={10000} />);
    const bottom = goalBottom(tree);
    expect(bottom).toBeLessThan(HEIGHT);
    // The axis gains headroom so the line sits at ~85% of the plot height.
    expect(bottom).toBeCloseTo(0.85 * HEIGHT, 5);
  });

  it("caps the goal at the headroom line even when it exactly equals the tallest bar", () => {
    const data: BarDatum[] = [
      { value: 100, label: "A" },
      { value: 40, label: "B" },
    ];
    const tree = render(<BarRow data={data} height={HEIGHT} goal={100} />);
    expect(goalBottom(tree)).toBeCloseTo(0.85 * HEIGHT, 5);
  });

  it("positions a goal below the tallest bar proportionally", () => {
    const data: BarDatum[] = [
      { value: 100, label: "A" },
      { value: 20, label: "B" },
    ];
    const tree = render(<BarRow data={data} height={HEIGHT} goal={50} />);
    // axisMax stays the data max (100), so the line sits at 50% of the plot.
    expect(goalBottom(tree)).toBeCloseTo(0.5 * HEIGHT, 5);
  });

  it("renders no goal line without a goal", () => {
    const tree = render(<BarRow data={zeroWeek()} height={HEIGHT} />);
    expect(absoluteBottomNodes(tree)).toHaveLength(0);
  });
});
