import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { computerObservation } from "./computer-support.js";
import type { UnchangedVisualStreak } from "./computer-tools.js";
import {
  advanceUnchangedVisualGuard,
  computerVisualActionKey,
  MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS,
  observationToolResult,
  parseComputerActions,
  screenTreeFrameId,
  screenTreeRows,
  screenTreeToolResult,
  splitComputerActions,
  unchangedVisualActionBlocked,
  unchangedVisualLoopToolResult,
  unchangedVisualStreakAfterPageBrowser,
} from "./computer-tools.js";

describe("computer tool bridge", () => {
  it("tells the model how to recover from an over-limit batch", () => {
    const batch = Array.from({ length: 30 }, () => ({ kind: "click", x: 1, y: 1 }));
    expect(() => parseComputerActions(batch)).toThrow(
      "computer_act accepts at most 24 actions but got 30; none ran. Send the first 24 or fewer now, then the rest in a separate call.",
    );
    expect(() => parseComputerActions(batch.slice(0, 24))).not.toThrow();
  });

  it("normalizes a bounded batch into provider-neutral actions", () => {
    expect(
      parseComputerActions([
        { kind: "click", x: 20.4, y: 30.6 },
        { kind: "type", text: "hello" },
        { kind: "scroll", direction: "up", amount: 999 },
        { kind: "focus", application: "xterm" },
      ]),
    ).toEqual([
      { kind: "pointer", x: 20, y: 31, type: "click", button: "left" },
      { kind: "clipboard", text: "hello" },
      { kind: "scroll", direction: "up", amount: 20 },
      { kind: "focus", application: "xterm" },
    ]);
  });

  it("aims a scroll at a point when it has one, in whole screen pixels", () => {
    expect(
      parseComputerActions([
        { kind: "scroll", direction: "down", amount: 4, x: 600.4, y: 419.6 },
        { kind: "scroll", direction: "up" },
      ]),
    ).toEqual([
      { kind: "scroll", direction: "down", amount: 4, x: 600, y: 420 },
      { kind: "scroll", direction: "up", amount: 3 },
    ]);
  });

  it("scrolls in all four directions, in 1 to 20 notches, three by default", () => {
    expect(
      parseComputerActions([
        { kind: "scroll", direction: "left", amount: 0 },
        { kind: "scroll", direction: "right", amount: 25 },
        { kind: "scroll", direction: "sideways", amount: 2.6 },
      ]),
    ).toEqual([
      { kind: "scroll", direction: "left", amount: 3 },
      { kind: "scroll", direction: "right", amount: 20 },
      { kind: "scroll", direction: "down", amount: 3 },
    ]);
  });

  it("rejects a scroll point that is partial or negative", () => {
    expect(() => parseComputerActions([{ kind: "scroll", direction: "down", x: 600 }])).toThrow(
      /y must be a non-negative coordinate/,
    );
    expect(() =>
      parseComputerActions([{ kind: "scroll", direction: "down", x: -1, y: 420 }]),
    ).toThrow(/x must be a non-negative coordinate/);
  });

  it("tells repeated scrolls at different points apart", () => {
    const here = computerVisualActionKey(
      parseComputerActions([{ kind: "scroll", direction: "down", x: 100, y: 200 }]),
    );
    const there = computerVisualActionKey(
      parseComputerActions([{ kind: "scroll", direction: "down", x: 900, y: 200 }]),
    );
    expect(here).not.toBe(there);
  });

  it("keeps an optional URI on focus actions and rejects a missing application", () => {
    expect(
      parseComputerActions([
        { kind: "focus", application: "chromium", uri: "https://example.test" },
      ]),
    ).toEqual([{ kind: "focus", application: "chromium", uri: "https://example.test" }]);
    expect(() => parseComputerActions([{ kind: "focus" }])).toThrow(/application/);
    expect(() => parseComputerActions([{ kind: "focus", application: "   " }])).toThrow(
      /application/,
    );
  });

  it("requires a non-blank application on the focus tool variant", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "computer_act");
    const schema = tool?.inputSchema as {
      properties?: {
        actions?: {
          items?: {
            oneOf?: Array<{
              required?: string[];
              properties?: {
                kind?: { enum?: string[] };
                application?: { minLength?: number; pattern?: string };
              };
            }>;
          };
        };
      };
    };
    const items = schema?.properties?.actions?.items ?? {};
    const focus = items.oneOf?.find((branch) => branch.properties?.kind?.enum?.includes("focus"));
    const other = items.oneOf?.find((branch) => branch !== focus);
    expect(focus?.required).toEqual(["kind", "application"]);
    expect(focus?.properties?.application).toMatchObject({ minLength: 1, pattern: "\\S" });
    expect(other?.required).toEqual(["kind"]);
    expect(other?.properties?.kind?.enum).not.toContain("focus");
  });

  it("rejects batches whose expanded double-click actions exceed the limit", () => {
    expect(() =>
      parseComputerActions(
        Array.from({ length: 13 }, () => ({ kind: "click", x: 10, y: 10, double: true })),
      ),
    ).toThrow(
      "computer_act accepts at most 24 actions but got 26 after expansion; none ran. Send fewer now, then the rest in a separate call. A double click counts as two actions.",
    );
    expect(
      parseComputerActions(
        Array.from({ length: 12 }, () => ({ kind: "click", x: 10, y: 10, double: true })),
      ),
    ).toHaveLength(24);
  });

  it("returns observations as model-visible image content", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const result = observationToolResult(observation);
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: "AQID", mimeType: "image/png" },
    ]);
  });

  it("does not resend an unchanged screenshot", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const result = observationToolResult(observation, "observed", observation.frameId);

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "The previous screenshot remains valid; this identical frame was omitted.",
        ),
      }),
    ]);
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(result.details).toMatchObject({
      frameId: observation.frameId,
      screenUnchanged: true,
      screenshotOmitted: true,
      previousScreenshotValid: true,
    });
  });

  it("stops repeating an identical visual action after unchanged frames", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const scrollActions = parseComputerActions([{ kind: "scroll", direction: "down", amount: 3 }]);
    const otherScrollActions = parseComputerActions([
      { kind: "scroll", direction: "up", amount: 3 },
    ]);
    const scroll = computerVisualActionKey(scrollActions);
    const otherScroll = computerVisualActionKey(otherScrollActions);
    expect(scroll).toBeTypeOf("string");
    expect(otherScroll).not.toBe(scroll);
    expect(
      computerVisualActionKey(parseComputerActions([{ kind: "type", text: "hello" }])),
    ).toBeUndefined();

    let streak: UnchangedVisualStreak = { count: 0 };
    streak = advanceUnchangedVisualGuard(streak, observation.frameId).streak;

    for (let index = 0; index < MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS - 1; index += 1) {
      const guard = advanceUnchangedVisualGuard(streak, observation.frameId, scroll);
      streak = guard.streak;
      expect(guard.engaged).toBe(false);
    }
    expect(unchangedVisualActionBlocked(streak, scrollActions)).toBe(false);
    const early = observationToolResult(observation, "observed", observation.frameId, {
      unchangedVisualCount: streak.count,
    });
    expect(early.details).toMatchObject({
      previousScreenshotValid: true,
      unchangedVisualCount: streak.count,
    });
    expect(early.details).not.toMatchObject({ unchangedVisualLoop: true });

    const engaged = advanceUnchangedVisualGuard(streak, observation.frameId, scroll);
    streak = engaged.streak;
    expect(engaged.engaged).toBe(true);
    expect(streak.count).toBe(MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS);
    expect(unchangedVisualActionBlocked(streak, scrollActions)).toBe(true);
    expect(unchangedVisualActionBlocked(streak, otherScrollActions)).toBe(false);
    const preserved = advanceUnchangedVisualGuard(streak, observation.frameId);
    expect(preserved.streak.count).toBe(MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS);
    expect(unchangedVisualActionBlocked(preserved.streak, scrollActions)).toBe(true);

    const marked = observationToolResult(observation, "observed", observation.frameId, {
      unchangedVisualCount: streak.count,
    });
    expect(marked.content.some((part) => part.type === "image")).toBe(false);
    expect(marked.details).toMatchObject({
      screenUnchanged: true,
      screenshotOmitted: true,
      previousScreenshotValid: true,
      unchangedVisualLoop: true,
      unchangedVisualCount: MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS,
    });
    expect(marked.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("browser_snapshot"),
      }),
    );

    const refused = unchangedVisualLoopToolResult(streak);
    expect(refused.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("was not run again"),
      }),
    ]);
    expect(refused.details).toMatchObject({
      previousScreenshotValid: true,
      unchangedVisualLoop: true,
    });

    const changed = computerObservation(Uint8Array.from([9, 9, 9]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const reset = advanceUnchangedVisualGuard(streak, changed.frameId, scroll);
    expect(reset.engaged).toBe(false);
    expect(reset.streak.count).toBe(0);
    expect(unchangedVisualActionBlocked(reset.streak, scrollActions)).toBe(false);
    const refreshed = observationToolResult(changed, "observed", observation.frameId);
    expect(refreshed.content).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image" }),
    ]);
  });

  it("blocks a scroll padded with waits and still runs typing", () => {
    const observation = computerObservation(Uint8Array.from([1, 2, 3]), {
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    const scrollActions = parseComputerActions([{ kind: "scroll", direction: "down", amount: 3 }]);
    const scroll = computerVisualActionKey(scrollActions);
    let streak: UnchangedVisualStreak = { count: 0 };
    streak = advanceUnchangedVisualGuard(streak, observation.frameId).streak;
    for (let index = 0; index < MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS; index += 1) {
      streak = advanceUnchangedVisualGuard(streak, observation.frameId, scroll).streak;
    }
    const withType = parseComputerActions([
      { kind: "scroll", direction: "down", amount: 3 },
      { kind: "type", text: "hello" },
    ]);
    const withWait = parseComputerActions([
      { kind: "scroll", direction: "down", amount: 3 },
      { kind: "wait", ms: 100 },
    ]);
    const withTwoWaits = parseComputerActions([
      { kind: "scroll", direction: "down", amount: 3 },
      { kind: "wait", ms: 100 },
      { kind: "wait", ms: 100 },
    ]);

    expect(computerVisualActionKey(withType)).toBe(scroll);
    expect(computerVisualActionKey(withWait)).toBe(scroll);
    expect(unchangedVisualActionBlocked(streak, scrollActions)).toBe(true);
    expect(unchangedVisualActionBlocked(streak, withWait)).toBe(true);
    expect(unchangedVisualActionBlocked(streak, withTwoWaits)).toBe(true);
    expect(unchangedVisualActionBlocked(streak, withType)).toBe(false);
    expect(
      unchangedVisualActionBlocked(streak, parseComputerActions([{ kind: "type", text: "hello" }])),
    ).toBe(false);
  });

  it("clears the visual streak after a successful page mutation", () => {
    const engaged: UnchangedVisualStreak = {
      frameId: "frame-1",
      actionKey: "scroll",
      count: MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS,
    };
    const navigated = { url: "https://example.test", title: "Example" };
    const acted = { ok: true, completed: 1, url: "https://example.test", title: "Example" };
    const failed = { error: "could not navigate", fallback: "computer_act" as const };

    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_navigate", navigated)).toEqual({
      count: 0,
    });
    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_act", acted)).toEqual({
      count: 0,
    });
    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_snapshot", navigated)).toEqual(
      engaged,
    );
    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_navigate", failed)).toEqual(
      engaged,
    );
    expect(unchangedVisualStreakAfterPageBrowser(engaged, "browser_act", { ok: false })).toEqual(
      engaged,
    );
  });
});

describe("screen tree bridge", () => {
  it("splits element actions from coordinate actions", () => {
    const split = splitComputerActions([
      { kind: "click", element: 16 },
      { kind: "click", x: 5, y: 9 },
      { kind: "type", element: 12, text: "hi" },
      { kind: "set", element: 12, value: "set-me" },
      { kind: "key", element: 12, key: "Return" },
      { kind: "scroll", element: 20, direction: "down" },
      { kind: "wait", ms: 200 },
    ]);
    expect(split.element).toEqual([
      { kind: "click", element: 16 },
      { kind: "type", element: 12, text: "hi" },
      { kind: "set", element: 12, value: "set-me" },
      { kind: "key", element: 12, key: "Return" },
      { kind: "scroll", element: 20, direction: "down", amount: 3 },
    ]);
    expect(split.actions).toEqual([
      { kind: "click", x: 5, y: 9 },
      { kind: "wait", ms: 200 },
    ]);
  });

  it("rejects element numbers out of range and kinds that cannot take one", () => {
    expect(() => splitComputerActions([{ kind: "click", element: 100001 }])).toThrow(
      "element must be an integer between 0 and 100000",
    );
    expect(() => splitComputerActions([{ kind: "focus", element: 1 }])).toThrow(
      "kind focus cannot take an element number",
    );
  });

  it("maps tree rows to element numbers", () => {
    const rows = screenTreeRows(
      '- [0] frame "New Tab"\n  - [12] entry "Address and search bar"\n no number here\n  - [16] push button "Chromium"',
    );
    expect(rows.get(12)).toBe('entry "Address and search bar"');
    expect(rows.get(16)).toBe('push button "Chromium"');
    expect(rows.size).toBe(3);
  });

  it("combines frame and tree identity so either changing breaks the dedup", () => {
    const same = screenTreeFrameId("frame", "tree");
    expect(screenTreeFrameId("frame", "tree")).toBe(same);
    expect(screenTreeFrameId("frame2", "tree")).not.toBe(same);
    expect(screenTreeFrameId("frame", "tree2")).not.toBe(same);
  });

  it("renders the tree as text and keeps the image optional", () => {
    const observation = {
      frameId: "f1",
      capturedAt: "2026-11-10T00:00:00.000Z",
      windowTitle: "New Tab - Chromium",
      elements: 38,
      tree: '- [0] frame "New Tab"',
    };
    const withImage = screenTreeToolResult(
      observation,
      { data: "aGk=", mimeType: "image/png" as const },
      "computer observed",
      undefined,
    );
    expect(withImage.content).toEqual([
      { type: "text", text: 'computer observed\nNew Tab - Chromium\n\n- [0] frame "New Tab"' },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
    const withoutImage = screenTreeToolResult(observation, undefined, "computer observed", "f1");
    expect(withoutImage.content).toHaveLength(1);
    const text = withoutImage.content[0];
    expect(text).toMatchObject({ type: "text" });
    expect(text?.type === "text" ? text.text : "").toContain("(screen unchanged)");
  });
});
