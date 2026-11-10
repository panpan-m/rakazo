import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_DESKTOP_ENV,
  ensureScreenCommand,
  stopExtraScreenCommand,
} from "@rakazo/core/node/desktop-runtime";
import { expect, it } from "vitest";

/**
 * Build the computer image first (`pnpm sandbox:build`). This opt-in check needs Docker but no
 * network or credentials: it verifies the whole screen-tree path in the real image — the
 * accessibility daemon starts with the browser, Chromium publishes a real element tree, and an
 * element click with the expected row runs against a fresh snapshot while a stale one refuses.
 */
it.skipIf(process.env.VERIFY_DOCKER_SCREEN_TREE !== "1")(
  "serves an element tree of the browser desktop and acts on a row",
  () => {
    const name = `rakazo-screen-tree-test-${randomUUID()}`;
    const directory = mkdtempSync(path.join(tmpdir(), "rakazo-screen-tree-"));
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 180_000 });
    // A refusal is a designed outcome: the helper answers on stdout and exits 2.
    const helper = (request: string) => {
      try {
        return docker(
          "exec",
          name,
          "sh",
          "-c",
          'printf %s "$1" | /usr/local/bin/rakazo-screen-tree',
          "sh",
          request,
        );
      } catch (error) {
        const stdout = (error as { stdout?: string }).stdout;
        if (typeof stdout === "string" && stdout.trim()) return stdout;
        throw error;
      }
    };
    try {
      const commands = {
        ensure: ensureScreenCommand(0, "bot-tree", "view-tree-1", {
          ...DEFAULT_DESKTOP_ENV,
          screenTree: true,
        }),
        stop: stopExtraScreenCommand(0, "bot-tree", {
          ...DEFAULT_DESKTOP_ENV,
          screenTree: true,
        }),
      };
      const commandFile = path.join(directory, "commands.json");
      writeFileSync(commandFile, JSON.stringify(commands));
      const runner = path.join(directory, "run.py");
      writeFileSync(
        runner,
        [
          "import json, subprocess, sys",
          "commands = json.load(open(sys.argv[1]))",
          'key = sys.argv[2] if len(sys.argv) > 2 else "ensure"',
          'print(subprocess.run(["bash", "-c", commands[key]], timeout=150,',
          "      capture_output=True, text=True).stderr[-2000:])",
        ].join("\n"),
      );
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "--shm-size=512m",
        process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local",
      );
      docker("cp", commandFile, `${name}:/tmp/screen-tree-commands.json`);
      docker("cp", runner, `${name}:/tmp/screen-tree-run.py`);
      docker("exec", name, "python3", "/tmp/screen-tree-run.py", "/tmp/screen-tree-commands.json");
      // The daemon must be listening before the browser launched, and still be alive after.
      expect(
        docker(
          "exec",
          name,
          "sh",
          "-c",
          "test -S /tmp/rakazo/screen-tree-1.sock && echo socket-ok",
        ),
      ).toContain("socket-ok");

      const observed = JSON.parse(helper('{"display":":1"}'));
      expect(observed.ok).toBe(true);
      // A degraded read (X11 fallback only) reports one window row and nothing else.
      expect(observed.elements).toBeGreaterThan(5);
      expect(observed.tree).toContain("push button");

      // Act through a fresh snapshot: the reload button is stable and offline-safe.
      const row = /(\d+)\] push button "Reload"/.exec(observed.tree)?.[1];
      expect(row).toBeDefined();
      const rowNumber = Number(row);
      const rowText = `push button "Reload" (description "Reload this page") [actions=[press,showContextMenu]]`;
      const request = {
        display: ":1",
        actions: [{ kind: "click", element: rowNumber }],
        expectedRows: { [String(rowNumber)]: rowText },
      };
      const acted = JSON.parse(helper(JSON.stringify(request)));
      expect(acted.ok).toBe(true);
      expect(acted.actions).toEqual([{ index: 0, ok: true }]);
      expect(acted.tree).toContain("push button");

      // A row that no longer reads as observed refuses instead of clicking a replacement.
      const stale = JSON.stringify({
        ...request,
        expectedRows: { [String(rowNumber)]: 'push button "Nothing"' },
      });
      const refused = JSON.parse(helper(stale));
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("changed since the last observation");

      // Releasing the screen stops the daemon for real, not just in the rendered script.
      docker(
        "exec",
        name,
        "python3",
        "/tmp/screen-tree-run.py",
        "/tmp/screen-tree-commands.json",
        "stop",
      );
      expect(
        docker(
          "exec",
          name,
          "sh",
          "-c",
          "test -S /tmp/rakazo/screen-tree-1.sock && echo alive || echo gone",
        ),
      ).toContain("gone");
      expect(
        docker(
          "exec",
          name,
          "sh",
          "-c",
          // The bracket keeps the check from matching its own command line.
          "if pgrep -f '[s]erve --socket /tmp/rakazo/screen-tree-1.sock' >/dev/null; then echo daemon-alive; else echo daemon-gone; fi",
        ),
      ).toContain("daemon-gone");
    } finally {
      try {
        docker("rm", "-f", name);
      } catch {
        // Cleanup must not replace the original test failure.
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
  240_000,
);
