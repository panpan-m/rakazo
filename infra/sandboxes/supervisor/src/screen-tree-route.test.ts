import { Duplex, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  exec: vi.fn(),
  inspect: vi.fn(),
  stdin: [] as string[],
  exitCode: 0,
  helperReply: "",
}));

vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.stdin.length = 0;
  mock.exitCode = 0;
  mock.helperReply = "";
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => ({
    start: async () =>
      Duplex.from({
        readable: Readable.from([
          Buffer.from(
            options.Cmd.includes("/usr/local/bin/rakazo-screen-tree") ? mock.helperReply : "",
          ),
        ]),
        writable: new Writable({
          write(chunk, _encoding, callback) {
            if (options.Cmd.includes("/usr/local/bin/rakazo-screen-tree")) {
              mock.stdin.push(String(chunk));
            }
            callback();
          },
        }),
      }),
    inspect: async () => ({
      ExitCode: options.Cmd.includes("rakazo-screen-tree") ? mock.exitCode : 0,
    }),
  }));
});

async function screenTree(body: Record<string, unknown>) {
  return supervisorApp.request("/computers/computer-1/screen-tree", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "screen",
      "x-rakazo-screen-lease-id": "run:1",
    },
    body: JSON.stringify(body),
  });
}

describe("screen tree route", () => {
  it("runs the helper on the leased screen and returns its tree", async () => {
    mock.helperReply = JSON.stringify({
      ok: true,
      window: { pid: 10, windowId: 20, title: "New Tab - Chromium" },
      snapshotId: "s00000001",
      tree: '- [0] frame "New Tab"',
      truncated: false,
      elements: 1,
      actions: [],
    });
    const response = await screenTree({});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      window: { title: "New Tab - Chromium" },
      tree: '- [0] frame "New Tab"',
    });
    // The request reaches the helper over stdin, with the bot's display resolved.
    const request = JSON.parse(mock.stdin[0] ?? "{}");
    expect(request.display).toContain(":");
  });

  it("passes an actionable helper refusal through", async () => {
    mock.exitCode = 2;
    mock.helperReply = JSON.stringify({
      ok: false,
      error: "element [16] changed since the last observation; observe again",
    });
    const response = await screenTree({
      actions: [{ kind: "click", element: 16 }],
      expectedRows: { "16": "push button" },
    });
    expect(await response.json()).toEqual({
      ok: false,
      error: "element [16] changed since the last observation; observe again",
    });
    const request = JSON.parse(mock.stdin[0] ?? "{}");
    expect(request.expectedRows).toEqual({ "16": "push button" });
  });

  it("reports an old image's missing helper as unavailable, not a crash", async () => {
    mock.exitCode = 127;
    mock.helperReply = "";
    const response = await screenTree({});
    const body = (await response.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("screen_tree_unavailable");
  });

  it("rejects a malformed request before touching the computer", async () => {
    const response = await screenTree({ actions: [{ kind: "click", element: -1 }] });
    expect(response.status).toBe(400);
    expect(mock.stdin).toHaveLength(0);
  });
});
