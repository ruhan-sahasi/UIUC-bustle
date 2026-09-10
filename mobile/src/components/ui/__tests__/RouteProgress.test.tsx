/**
 * RouteProgress structure tests.
 *
 * The Fabric rule under test: ANY animated prop write on ANY SVG node
 * invalidates the WHOLE enclosing `<Svg>`. RouteProgress animates two nodes —
 * the drawing polyline (strokeDashoffset) and the traveling dot (cx/cy/
 * opacity) — and it loops on the sign-in screen, so those two nodes sharing
 * one document meant each was re-rendering the other (plus the static track)
 * every frame, forever. These tests pin the split: each animating node lives
 * in its OWN absolutely-stacked `<Svg>` of identical geometry.
 */
import { render, type RenderResult } from "@testing-library/react-native";
import React from "react";
import Svg, { Circle, Polyline } from "react-native-svg";
import { RouteProgress } from "../motion";

type TestInstance = {
  props: Record<string, unknown>;
  findAllByType: (type: unknown) => TestInstance[];
};

const POINTS = [
  { x: 0, y: 0 },
  { x: 20, y: 10 },
  { x: 40, y: 0 },
];

function svgs(tree: RenderResult): TestInstance[] {
  return tree.UNSAFE_root.findAllByType(Svg as never) as unknown as TestInstance[];
}

describe("RouteProgress SVG layering", () => {
  it("gives the animated line and the animated dot separate <Svg> documents", () => {
    const tree = render(<RouteProgress points={POINTS} showDot />);
    for (const svg of svgs(tree)) {
      const lines = svg.findAllByType(Polyline as never);
      const dots = svg.findAllByType(Circle as never);
      // No document holds both animating nodes — a dashoffset write must not
      // invalidate the dot's document, nor the dot's travel the line's.
      expect(lines.length > 0 && dots.length > 0).toBe(false);
    }
  });

  it("stacks track, line, and dot as three sibling documents when all are shown", () => {
    const tree = render(
      <RouteProgress points={POINTS} showDot trackColor="rgba(255,255,255,0.14)" />
    );
    const all = svgs(tree);
    expect(all).toHaveLength(3);
    // Identical geometry: every layer spans the same box, so they line up.
    const sizes = all.map((svg) => [svg.props.width, svg.props.height]);
    expect(sizes[1]).toEqual(sizes[0]);
    expect(sizes[2]).toEqual(sizes[0]);
  });

  it("renders two documents without a track, one without a dot", () => {
    const noTrack = render(<RouteProgress points={POINTS} showDot />);
    expect(svgs(noTrack)).toHaveLength(2);

    const noDot = render(<RouteProgress points={POINTS} showDot={false} />);
    expect(svgs(noDot)).toHaveLength(1);
  });

  it("renders nothing with fewer than two points", () => {
    const tree = render(<RouteProgress points={[{ x: 0, y: 0 }]} />);
    expect(tree.toJSON()).toBeNull();
  });
});
