/**
 * Odometer digit-column tests.
 *
 * The defect these pin down: a column tweening from digit 9 to digit 0 used to
 * animate its strip from -9h back to 0 — a full backwards spin through every
 * intermediate digit, once a second on a live countdown. The contract now is:
 *
 *   - an ADJACENT digit step (±1) rolls with `withTiming`;
 *   - anything else — the 9 -> 0 / 0 -> 9 wrap, or a data jump — SNAPS.
 *
 * `withTiming` is spied on (same technique as motion.test.tsx's `withRepeat`
 * spy) so the assertion is about what was STARTED, which jest can see, rather
 * than about frames, which it cannot.
 *
 * Fake timers are required here: `useAnimatedReaction` mappers only execute
 * when Reanimated's jest frame clock advances, so every mount and every shared
 * value write is followed by `jest.advanceTimersByTime`.
 */
jest.mock("react-native-reanimated", () => {
  const actual = jest.requireActual("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    default: actual.default,
    withTiming: jest.fn((...args: unknown[]) =>
      (actual.withTiming as (...a: unknown[]) => unknown)(...args)
    ),
  };
});

import { act, render, type RenderResult } from "@testing-library/react-native";
import React from "react";
import { makeMutable, withTiming, type SharedValue } from "react-native-reanimated";
import { Odometer } from "../motion";

const timingCalls = withTiming as unknown as jest.Mock;

jest.useFakeTimers();

/** Let Reanimated's jest frame clock run the pending reaction (and any tween). */
function tick(ms = 64) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/** Every text cell's content, in render order. */
function digitCells(tree: RenderResult): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node == null) return;
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return;
    }
    if (typeof node !== "object") return;
    ((node as { children?: unknown[] }).children ?? []).forEach(walk);
  };
  walk(tree.toJSON());
  return out;
}

describe("Odometer digit strip", () => {
  it("renders exactly ten cells per column, 0 through 9, with no trailing wrap cell", () => {
    const tree = render(<Odometer value={7} places={2} accessibilityLabel="minutes until the 22N" />);
    const cells = digitCells(tree);
    const oneColumn = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    // Two places → the strip repeats once per column and nothing else. In
    // particular there is no dead 11th "0" cell left over from the abandoned
    // roll-off-the-bottom design.
    expect(cells).toEqual([...oneColumn, ...oneColumn]);
  });
});

describe("Odometer digit transitions (SharedValue source)", () => {
  let sv: SharedValue<number>;

  function mount() {
    sv = makeMutable(9);
    const tree = render(
      <Odometer value={sv} places={1} accessibilityLabel="seconds remaining" digitHeight={20} />
    );
    // The mount reaction (previous === null) snaps the column onto its first
    // digit; that write is setup, not evidence.
    tick();
    timingCalls.mockClear();
    return tree;
  }

  function write(next: number) {
    act(() => {
      sv.value = next;
    });
    tick();
  }

  /** The digit column's resolved translateY, from its jestAnimatedStyle. */
  function columnY(tree: ReturnType<typeof render>): number {
    const styles: Array<Record<string, unknown>> = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as { props?: Record<string, unknown>; children?: unknown[] };
      if (n.props?.jestAnimatedStyle) {
        styles.push((n.props.jestAnimatedStyle as { value: Record<string, unknown> }).value);
      }
      (n.children ?? []).forEach(walk);
    };
    walk(tree.toJSON());
    const withY = styles.find((s) => Array.isArray(s.transform));
    expect(withY).toBeDefined();
    const t = (withY!.transform as Array<Record<string, number>>).find((e) => "translateY" in e);
    expect(t).toBeDefined();
    // Digit 0's offset computes as -0; the same pixel as 0, but `toBe` uses
    // Object.is and would fail over the sign of the worklet's arithmetic.
    return t!.translateY + 0;
  }

  it("rolls an adjacent step with a timing animation", () => {
    mount();
    write(8);
    // 9 -> 8 is adjacent: the column tweens to its new offset (-8 * 20).
    expect(timingCalls).toHaveBeenCalled();
    expect(timingCalls.mock.calls.some(([target]) => target === -8 * 20)).toBe(true);
  });

  it("snaps the 9 -> 0 wrap instead of spinning backwards through every digit", () => {
    const tree = mount();
    write(0);
    // Non-adjacent (|0 - 9| = 9): the strip must NOT animate — a tween here is
    // the backwards ten-digit spin this component shipped with — and the
    // column must already REST at digit 0's offset with no clock to wait out.
    expect(timingCalls).not.toHaveBeenCalled();
    expect(columnY(tree)).toBe(0);
  });

  it("snaps the 0 -> 9 countdown wrap too", () => {
    const tree = mount();
    write(0);
    timingCalls.mockClear();
    write(9);
    expect(timingCalls).not.toHaveBeenCalled();
    expect(columnY(tree)).toBe(-9 * 20);
  });

  it("snaps arbitrary jumps", () => {
    const tree = mount();
    write(3);
    expect(timingCalls).not.toHaveBeenCalled();
    expect(columnY(tree)).toBe(-3 * 20);
  });
});
