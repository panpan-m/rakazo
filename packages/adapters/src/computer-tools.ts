import { createHash } from "node:crypto";
import type {
  AgentToolExecutionResult,
  ComputerAction,
  ComputerObservation,
  ScreenTreeAction,
} from "@rakazo/adapter-kit";
import { scrollDirection } from "@rakazo/core";
import { computerActionCount, MAX_ACTIONS_PER_CALL } from "./tool-loop.js";

/** Identical visual actions that leave the frame unchanged before computer_act stops repeating them. */
export const MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS = 3;

const VISUAL_COMPUTER_ACTIONS = new Set<ComputerAction["kind"]>(["scroll", "pointer", "key"]);

const PREVIOUS_SCREENSHOT_VALID =
  "The previous screenshot remains valid; this identical frame was omitted.";

export type UnchangedVisualStreak = {
  frameId?: string;
  actionKey?: string;
  count: number;
};

export type ObservationToolOptions = {
  /** Consecutive identical visual actions that left this frame unchanged. */
  unchangedVisualCount?: number;
};

export function parseComputerActions(value: unknown): ComputerAction[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("computer_act requires at least one action");
  }
  if (value.length > MAX_ACTIONS_PER_CALL) {
    throw new Error(
      `computer_act accepts at most ${MAX_ACTIONS_PER_CALL} actions but got ${value.length}; none ran. Send the first ${MAX_ACTIONS_PER_CALL} or fewer now, then the rest in a separate call.`,
    );
  }
  const actions = value.flatMap((raw): ComputerAction[] => {
    if (!raw || typeof raw !== "object") throw new Error("computer action must be an object");
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "");
    if (kind === "click" || kind === "move" || kind === "down" || kind === "up") {
      const x = finiteCoordinate(action.x, "x");
      const y = finiteCoordinate(action.y, "y");
      const pointer: ComputerAction = {
        kind: "pointer",
        x,
        y,
        type: kind,
        button: action.button === "right" ? "right" : "left",
      };
      return computerActionCount(action) === 2 ? [pointer, pointer] : [pointer];
    }
    if (kind === "type") {
      return [{ kind: "clipboard", text: String(action.text ?? "") }];
    }
    if (kind === "key") {
      return [
        {
          kind: "key",
          key: String(action.key ?? ""),
          modifiers: Array.isArray(action.modifiers) ? action.modifiers.map(String) : undefined,
        },
      ];
    }
    if (kind === "scroll") {
      // A point is optional, and needs both coordinates: the wheel turns where the pointer is.
      const at =
        action.x === undefined && action.y === undefined
          ? {}
          : { x: finiteCoordinate(action.x, "x"), y: finiteCoordinate(action.y, "y") };
      return [
        {
          kind: "scroll",
          direction: scrollDirection(action.direction),
          // Wheel notches; none or fewer means the default three.
          amount: Number(action.amount) > 0 ? boundedNumber(action.amount, 1, 20, 3) : 3,
          ...at,
        },
      ];
    }
    if (kind === "wait") {
      return [{ kind: "wait", ms: boundedNumber(action.ms, 0, 5_000, 350) }];
    }
    if (kind === "focus") {
      const application = String(action.application ?? "").trim();
      if (!application) throw new Error("computer action focus requires an application");
      return [
        {
          kind: "focus",
          application,
          ...(action.uri === undefined ? {} : { uri: String(action.uri) }),
        },
      ];
    }
    throw new Error(`unsupported computer action ${kind || "(missing)"}`);
  });
  if (actions.length > MAX_ACTIONS_PER_CALL) {
    throw new Error(
      `computer_act accepts at most ${MAX_ACTIONS_PER_CALL} actions but got ${actions.length} after expansion; none ran. Send fewer now, then the rest in a separate call. A double click counts as two actions.`,
    );
  }
  return actions;
}

export function observationToolResult(
  observation: ComputerObservation,
  note = "computer observed",
  previousFrameId?: string,
  options?: ObservationToolOptions,
): AgentToolExecutionResult {
  const unchanged = previousFrameId === observation.frameId;
  const unchangedVisualCount = options?.unchangedVisualCount ?? 0;
  const visualLoop = unchanged && unchangedVisualCount >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS;
  const details = {
    frameId: observation.frameId,
    capturedAt: observation.capturedAt,
    width: observation.width,
    height: observation.height,
    cursor: observation.cursor,
    activeWindow: observation.activeWindow,
    ...(unchanged ? unchangedScreenDetails(observation.frameId, unchangedVisualCount) : {}),
  };
  const status = unchanged
    ? visualLoop
      ? ` (screen unchanged). ${PREVIOUS_SCREENSHOT_VALID} ${visualLoopGuidance(unchangedVisualCount)}`
      : ` (screen unchanged). ${PREVIOUS_SCREENSHOT_VALID}`
    : "";
  return {
    kind: "agent_tool_result",
    content: [
      {
        type: "text",
        text: `${note}${status}\n${JSON.stringify(details)}`,
      },
      ...(unchanged
        ? []
        : [
            {
              type: "image" as const,
              data: Buffer.from(observation.image).toString("base64"),
              mimeType: observation.mimeType,
            },
          ]),
    ],
    details,
  };
}

/** Stable identity for scroll, pointer, and key actions. Typing and waiting are not visual loops. */
export function computerVisualActionKey(actions: readonly ComputerAction[]): string | undefined {
  const visual = actions.filter((action) => VISUAL_COMPUTER_ACTIONS.has(action.kind));
  if (visual.length === 0) return undefined;
  return JSON.stringify(visual);
}

/** Split a computer_act batch into element-addressed and coordinate/other actions. */
export function splitComputerActions(value: readonly unknown[]): {
  element: ScreenTreeAction[];
  actions: unknown[];
} {
  const element: ScreenTreeAction[] = [];
  const other: Record<string, unknown>[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") throw new Error("computer action must be an object");
    const action = raw as Record<string, unknown>;
    if (action.element === undefined) {
      other.push(action);
      continue;
    }
    const elementNumber = action.element;
    if (
      typeof elementNumber !== "number" ||
      !Number.isInteger(elementNumber) ||
      elementNumber < 0 ||
      elementNumber > 100_000
    ) {
      throw new Error("element must be an integer between 0 and 100000");
    }
    const kind = String(action.kind ?? "");
    if (kind === "click") {
      element.push({
        kind: "click",
        element: elementNumber,
        ...(action.button === "right" ? { button: "right" as const } : {}),
        ...(action.double === true ? { double: true } : {}),
      });
    } else if (kind === "type") {
      element.push({ kind: "type", element: elementNumber, text: String(action.text ?? "") });
    } else if (kind === "set") {
      element.push({ kind: "set", element: elementNumber, value: String(action.value ?? "") });
    } else if (kind === "key") {
      const modifiers = Array.isArray(action.modifiers)
        ? action.modifiers.filter(
            (m): m is "ctrl" | "alt" | "shift" | "meta" =>
              m === "ctrl" || m === "alt" || m === "shift" || m === "meta",
          )
        : [];
      element.push({
        kind: "key",
        element: elementNumber,
        key: String(action.key ?? ""),
        ...(modifiers.length ? { modifiers } : {}),
      });
    } else if (kind === "scroll") {
      const direction = scrollDirection(action.direction);
      element.push({
        kind: "scroll",
        element: elementNumber,
        direction,
        amount: Number(action.amount) > 0 ? boundedNumber(action.amount, 1, 20, 3) : 3,
      });
    } else {
      throw new Error(`kind ${kind || "(missing)"} cannot take an element number`);
    }
  }
  return { element, actions: other };
}

/** Element numbers → tree row text, from the tree the model last observed. */
export function screenTreeRows(tree: string): Map<number, string> {
  const rows = new Map<number, string>();
  for (const line of tree.split("\n")) {
    const match = /\[(\d+)\]\s?(.*)$/.exec(line.trim());
    if (match && match[1] !== undefined && match[2] !== undefined) {
      rows.set(Number(match[1]), match[2].trim());
    }
  }
  return rows;
}

/** A screen observation that carries a tree is unchanged only when both parts match. */
export function screenTreeFrameId(frameId: string, tree: string): string {
  return createHash("sha256").update(`${frameId}\n${tree}`).digest("hex");
}

/** Stable identity for element actions that can loop unchanged, mirroring the visual set. */
export function screenTreeVisualActionKey(
  actions: readonly ScreenTreeAction[],
): string | undefined {
  const visual = actions.filter(
    (action) => action.kind === "click" || action.kind === "scroll" || action.kind === "key",
  );
  if (visual.length === 0) return undefined;
  return JSON.stringify(visual);
}

/** Shape a screen-tree observation for the model: the tree is the text, the image optional. */
export function screenTreeToolResult(
  observation: {
    frameId: string;
    capturedAt: string;
    width?: number;
    height?: number;
    cursor?: { x: number; y: number };
    activeWindow?: { id: string; title?: string };
    windowTitle?: string;
    elements?: number;
    truncated?: boolean;
    popupWindowId?: number;
    tree: string;
  },
  image: { data: string; mimeType: "image/png" | "image/jpeg" } | undefined,
  note = "computer observed",
  previousFrameId?: string,
  options?: ObservationToolOptions,
): AgentToolExecutionResult {
  const unchanged = previousFrameId === observation.frameId;
  const unchangedVisualCount = options?.unchangedVisualCount ?? 0;
  const visualLoop = unchanged && unchangedVisualCount >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS;
  const details = {
    frameId: observation.frameId,
    capturedAt: observation.capturedAt,
    width: observation.width,
    height: observation.height,
    cursor: observation.cursor,
    activeWindow: observation.activeWindow,
    window: observation.windowTitle,
    elements: observation.elements,
    truncated: observation.truncated,
    ...(observation.popupWindowId !== undefined
      ? { popupWindowId: observation.popupWindowId }
      : {}),
    ...(unchanged ? unchangedScreenDetails(observation.frameId, unchangedVisualCount) : {}),
  };
  const status = unchanged
    ? visualLoop
      ? ` (screen unchanged). ${PREVIOUS_SCREENSHOT_VALID} ${visualLoopGuidance(unchangedVisualCount)}`
      : ` (screen unchanged). ${PREVIOUS_SCREENSHOT_VALID}`
    : "";
  const heading = observation.windowTitle ? `${observation.windowTitle}\n\n` : "";
  return {
    kind: "agent_tool_result",
    content: [
      { type: "text", text: `${note}${status}\n${heading}${observation.tree}` },
      ...(unchanged || !image ? [] : [{ type: "image" as const, ...image }]),
    ],
    details,
  };
}

/** Typing and other non-wait actions still need to run. A wait does not. */
function batchEscapesVisualGuard(actions: readonly ComputerAction[]): boolean {
  return actions.some(
    (action) => action.kind !== "wait" && !VISUAL_COMPUTER_ACTIONS.has(action.kind),
  );
}

/**
 * Counts identical visual actions that keep the same frame. A new frame clears the streak.
 * Observations without a visual action leave an in-progress streak in place.
 */
export function advanceUnchangedVisualGuard(
  streak: UnchangedVisualStreak,
  frameId: string,
  actionKey?: string,
): { streak: UnchangedVisualStreak; engaged: boolean } {
  if (streak.frameId !== frameId) {
    return { streak: { frameId, count: 0 }, engaged: false };
  }
  if (!actionKey) return { streak, engaged: false };
  const count = streak.actionKey === actionKey ? streak.count + 1 : 1;
  const next = { frameId, actionKey, count };
  return {
    streak: next,
    engaged: count >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS,
  };
}

/** Refuse a matching visual batch. Waits do not exempt it; typing does. */
export function unchangedVisualActionBlocked(
  streak: UnchangedVisualStreak,
  actions: readonly ComputerAction[],
): boolean {
  if (batchEscapesVisualGuard(actions)) return false;
  const actionKey = computerVisualActionKey(actions);
  return (
    actionKey !== undefined &&
    actionKey === streak.actionKey &&
    streak.count >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS
  );
}

const MUTATING_PAGE_BROWSER_TOOLS = new Set(["browser_navigate", "browser_act"]);

function pageBrowserMutationSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as { error?: unknown; fallback?: unknown; ok?: unknown };
  if (record.fallback === "computer_act") return false;
  if (typeof record.error === "string" && record.error.length > 0) return false;
  if (record.ok === false) return false;
  return true;
}

/** A successful page mutation can change the live view without a new desktop frame. */
export function unchangedVisualStreakAfterPageBrowser(
  streak: UnchangedVisualStreak,
  toolName: string,
  result: unknown,
): UnchangedVisualStreak {
  if (!MUTATING_PAGE_BROWSER_TOOLS.has(toolName) || !pageBrowserMutationSucceeded(result)) {
    return streak;
  }
  return { count: 0 };
}

export function unchangedVisualLoopToolResult(
  streak: UnchangedVisualStreak,
): AgentToolExecutionResult {
  const details = unchangedScreenDetails(streak.frameId, streak.count);
  const text = `The same visual action left the screen unchanged ${streak.count} times and was not run again. The previous screenshot remains valid. Use browser_snapshot or a different action.`;
  return {
    kind: "agent_tool_result",
    content: [{ type: "text", text: `${text}\n${JSON.stringify(details)}` }],
    details,
  };
}

function unchangedScreenDetails(frameId: string | undefined, unchangedVisualCount: number) {
  return {
    frameId,
    screenUnchanged: true,
    screenshotOmitted: true,
    previousScreenshotValid: true,
    ...(unchangedVisualCount > 0 ? { unchangedVisualCount } : {}),
    ...(unchangedVisualCount >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS
      ? { unchangedVisualLoop: true }
      : {}),
  };
}

function visualLoopGuidance(count: number) {
  return `The same visual action has left the screen unchanged ${count} times. Stop repeating it and use browser_snapshot or a different action.`;
}

function finiteCoordinate(value: unknown, name: string) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0 || number > 100_000) {
    throw new Error(`computer action ${name} must be a non-negative coordinate`);
  }
  return number;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}
