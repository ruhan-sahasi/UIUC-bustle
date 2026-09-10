/**
 * `useReducedMotionResolved()` — the gate the root <ReducedMotionConfig> waits
 * on before it overwrites Reanimated's global reduce-motion flag.
 *
 * This lives in its own file on purpose: the flag it reports is module-level
 * state that latches true the first time AccessibilityInfo answers, so the
 * cold-start frame it describes can only be observed once per module registry.
 * The first test here is that one observation; keep it first.
 */
import { act, render } from "@testing-library/react-native";
import { AccessibilityInfo, Text } from "react-native";

import { useReducedMotion, useReducedMotionResolved } from "../motion";

let changeHandlers: ((enabled: boolean) => void)[] = [];
/** Gate that holds the isReduceMotionEnabled() promise open until released. */
let releaseAnswer: ((enabled: boolean) => void) | null = null;

beforeEach(() => {
  changeHandlers = [];
  releaseAnswer = null;
  jest.clearAllMocks();

  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockImplementation(() => new Promise<boolean>((resolve) => (releaseAnswer = resolve)));

  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(((
    event: string,
    handler: (enabled: boolean) => void,
  ) => {
    if (event === "reduceMotionChanged") changeHandlers.push(handler);
    return { remove: () => {} };
  }) as never);
});

function Probe() {
  const reduced = useReducedMotion();
  const resolved = useReducedMotionResolved();
  return <Text>{`${resolved ? "resolved" : "pending"}:${reduced ? "reduced" : "full"}`}</Text>;
}

it("stays pending until the answer lands, then resolves even when it matches the default", async () => {
  const tree = render(<Probe />);

  // The cold-start frame. The root layout must NOT mount its
  // ReducedMotionConfig here: `full` is only a guess, and writing it over
  // Reanimated's correct load-time snapshot would restore full motion for a
  // user who has Reduce Motion switched on.
  expect(tree.getByText("pending:full")).toBeTruthy();

  // The regression this file exists for: the store used to skip notifying
  // subscribers when the incoming value equalled the current one, so an OS
  // answer of `false` — the common case — left the gate closed forever and the
  // flag was never written at all.
  await act(async () => releaseAnswer?.(false));
  expect(tree.getByText("resolved:full")).toBeTruthy();
});

it("tracks a mid-session toggle without reopening the gate", async () => {
  const tree = render(<Probe />);
  await act(async () => releaseAnswer?.(false));

  await act(async () => changeHandlers.forEach((h) => h(true)));
  expect(tree.getByText("resolved:reduced")).toBeTruthy();

  await act(async () => changeHandlers.forEach((h) => h(false)));
  expect(tree.getByText("resolved:full")).toBeTruthy();
});
