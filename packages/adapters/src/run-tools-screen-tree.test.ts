import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { computerTools } from "./run-tools-computer.js";

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "space",
  userId: "u",
  signal: new AbortController().signal,
};

const observation = {
  frameId: "frame-1",
  capturedAt: "2026-11-10T00:00:00.000Z",
  mimeType: "image/png" as const,
  image: new Uint8Array([1, 2, 3]),
  width: 1280,
  height: 800,
  cursor: { x: 4, y: 6 },
};

const treeResult = (tree: string, extra: Record<string, unknown> = {}) =>
  ({
    ok: true as const,
    window: { pid: 10, windowId: 20, title: "New Tab - Chromium" },
    snapshotId: "s00000001",
    tree,
    truncated: false,
    elements: 2,
    actions: [{ index: 0, ok: true }],
    ...extra,
  }) as const;

const TREE = '- [0] frame "New Tab"\n  - [12] push button "Reload"';

/** A run context with just the fields the computer screen handlers read. */
function fixture(options: {
  screenTree: (...args: never[]) => Promise<unknown>;
  acceptsImages?: boolean;
  treeRows?: Map<number, string>;
}) {
  const observe = vi.fn(async () => observation);
  const sandbox = {
    observe,
    screenTree: options.screenTree as SandboxProvider["screenTree"],
  };
  const state = {
    screen: {
      lastFrameId: undefined as string | undefined,
      unchangedVisualStreak: { count: 0 },
      treeRows: options.treeRows,
    },
  };
  const ctx = {
    deps: { prisma: { taughtSkill: { findFirst: async () => null } }, sandbox },
    run: { spaceId: "space", botId: "b1", userId: "u" },
    bot: { id: "b1" },
    thread: { id: "t1" },
    runId: "r1",
    context,
    computer: {
      heldForTakeover: false,
      graphicalToolsAllowed: true,
      pageBrowserAllowed: false,
      screenTreeAllowed: Boolean(options.screenTree),
      acceptsImages: options.acceptsImages ?? true,
      mode: "private" as const,
      checkpoint: { markDirty: () => {} },
      get: async () => computer,
    },
    tools: { disabled: new Set<string>() },
    secrets: new Set<string>(),
    state,
  };
  const call = (name: string, args: Record<string, unknown>) => ({
    name,
    args,
    executionId: "e1",
    finish: async (result: unknown) => result,
  });
  return { ctx, call, state, observe };
}

/** Tool handlers are an optional map; the tests want the two they drive. */
function handler(name: "computer_observe" | "computer_act") {
  const fn = computerTools[name];
  if (!fn) throw new Error(`missing handler ${name}`);
  return fn;
}

describe("screen-tree computer tools", () => {
  it("merges the tree into an observation and keeps the image for a vision model", async () => {
    const screenTree = vi.fn(async () => treeResult(TREE));
    const { ctx, call } = fixture({ screenTree });
    const result = (await handler("computer_observe")(
      ctx as never,
      call("computer_observe", {}) as never,
    )) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain('push button "Reload"');
    expect(result.content[1]?.type).toBe("image");
    expect(ctx.state.screen.treeRows?.get(12)).toBe('push button "Reload"');
  });

  it("drops the image for a text-only model; the tree is the observation", async () => {
    const screenTree = vi.fn(async () => treeResult(TREE));
    const { ctx, call } = fixture({ screenTree, acceptsImages: false });
    const result = (await handler("computer_observe")(
      ctx as never,
      call("computer_observe", {}) as never,
    )) as { content: Array<{ type: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
  });

  it("falls back to a plain screenshot observation when the tree call fails", async () => {
    const screenTree = vi.fn(async () => {
      throw new Error("helper missing");
    });
    const { ctx, call, observe } = fixture({ screenTree });
    const result = (await handler("computer_observe")(
      ctx as never,
      call("computer_observe", {}) as never,
    )) as { content: Array<{ type: string }> };
    expect(observe).toHaveBeenCalled();
    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(ctx.state.screen.treeRows).toBeUndefined();
  });

  it("refuses to mix element and coordinate actions in one call", async () => {
    const screenTree = vi.fn();
    const { ctx, call } = fixture({ screenTree });
    const result = (await handler("computer_act")(
      ctx as never,
      call("computer_act", {
        actions: [
          { kind: "click", element: 12 },
          { kind: "click", x: 5, y: 9 },
        ],
      }) as never,
    )) as { error?: string };
    expect(result.error).toContain("Do not mix element and coordinate actions");
    expect(screenTree).not.toHaveBeenCalled();
  });

  it("refuses element actions before any tree observation", async () => {
    const { ctx, call } = fixture({ screenTree: vi.fn() });
    const result = (await handler("computer_act")(
      ctx as never,
      call("computer_act", { actions: [{ kind: "click", element: 12 }] }) as never,
    )) as { error?: string };
    expect(result.error).toContain("Observe the screen with computer_observe");
  });

  it("refuses an element number the last tree did not print", async () => {
    const { ctx, call } = fixture({
      screenTree: vi.fn(),
      treeRows: new Map([[12, 'push button "Reload"']]),
    });
    const result = (await handler("computer_act")(
      ctx as never,
      call("computer_act", { actions: [{ kind: "click", element: 99 }] }) as never,
    )) as { error?: string };
    expect(result.error).toContain("[99] is not in the last observed tree");
  });

  it("sends the observed row text with the action and renders the fresh tree", async () => {
    const screenTree = vi.fn(async (_c: unknown, request: { expectedRows?: unknown }) => {
      expect(request.expectedRows).toEqual({ 12: 'push button "Reload"' });
      return treeResult('- [0] frame "Reloaded"\n  - [12] push button "Reload"');
    });
    const { ctx, call } = fixture({
      screenTree,
      treeRows: new Map([[12, 'push button "Reload"']]),
    });
    const result = (await handler("computer_act")(
      ctx as never,
      call("computer_act", { actions: [{ kind: "click", element: 12 }] }) as never,
    )) as { content: Array<{ type: string; text?: string }> };
    expect(result.content[0]?.text).toContain("completed 1 element action");
    expect(result.content[0]?.text).toContain('frame "Reloaded"');
    expect(ctx.state.screen.treeRows?.get(12)).toBe('push button "Reload"');
  });

  it("keeps the completed count when the screen could not be re-read after actions", async () => {
    const screenTree = vi.fn(async () =>
      treeResult("", { observeError: "the popup closed before it could be read" }),
    );
    const { ctx, call } = fixture({
      screenTree,
      treeRows: new Map([[12, 'push button "Reload"']]),
    });
    const result = (await handler("computer_act")(
      ctx as never,
      call("computer_act", { actions: [{ kind: "click", element: 12 }] }) as never,
    )) as { ok?: boolean; completed?: number; error?: string };
    expect(result.ok).toBe(true);
    expect(result.completed).toBe(1);
    expect(result.error).toContain("could not be re-read");
    // Remembered rows must not survive an unknown screen state.
    expect(ctx.state.screen.treeRows).toBeUndefined();
  });

  it("passes an actionable tree refusal through to the model", async () => {
    const screenTree = vi.fn(async () => ({
      ok: false as const,
      error: "element [12] changed since the last observation; observe again",
    }));
    const { ctx, call } = fixture({
      screenTree,
      treeRows: new Map([[12, 'push button "Reload"']]),
    });
    const result = (await handler("computer_act")(
      ctx as never,
      call("computer_act", { actions: [{ kind: "click", element: 12 }] }) as never,
    )) as { error?: string };
    expect(result.error).toContain("changed since the last observation");
  });
});
