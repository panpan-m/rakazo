#!/usr/bin/python3 -I
"""Serve element-tree observation and element actions for the desktop on this DISPLAY.

The pinned accessibility driver walks the desktop's AT-SPI tree and speaks MCP over
stdio. This wrapper keeps Rakazo's contract on top: one JSON request on stdin, one
JSON response on stdout, one short-lived driver session per request, fresh tokens
for every action, and bounded output. Element numbers `[N]` in the returned tree
address the same window until the next observation; a refusal asks for a fresh read
instead of guessing.
"""

from __future__ import annotations

import json
import os
import re
import select
import subprocess
import sys
import time
from typing import Any

MAX_TREE_CHARS = 40_000
MAX_ELEMENTS = 400
MAX_ACTIONS = 24
MAX_TEXT_CHARS = 10_000
MAX_QUERY_CHARS = 200
SETTLE_MS = 300
DRIVER_DEADLINE_S = 60.0
MODIFIERS = {"ctrl", "alt", "shift", "meta", "super", "cmd"}
DIRECTIONS = {"up", "down", "left", "right"}


class Refused(Exception):
    """The driver answered with an actionable refusal; the caller can adapt."""


class Failed(Exception):
    """The session could not produce an answer."""


def die(code: int, **body: Any) -> None:
    json.dump({"ok": False, **body}, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(code)


def require_str(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise Failed(f"{name} must be a string of 1..{limit} characters")
    return value


def parse_element(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 100_000:
        raise Failed("element must be an integer between 0 and 100000")
    return value


def parse_actions(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not raw:
        raise Failed("actions must be a non-empty array when present")
    if len(raw) > MAX_ACTIONS:
        raise Failed(f"at most {MAX_ACTIONS} actions per call")
    actions: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise Failed("each action must be an object")
        kind = item.get("kind")
        if kind == "wait":
            ms = item.get("ms", 350)
            if not isinstance(ms, int) or not 0 <= ms <= 5_000:
                raise Failed("wait ms must be an integer between 0 and 5000")
            actions.append({"tool": None, "arguments": {"ms": ms}, "element": None})
            continue
        element = parse_element(item.get("element"))
        if kind == "click":
            button = item.get("button", "left")
            if button not in ("left", "right"):
                raise Failed("click button must be left or right")
            actions.append(
                {
                    "tool": "click",
                    "arguments": {
                        "element_token": None,
                        "button": button,
                        "count": 2 if item.get("double") else 1,
                    },
                    "element": element,
                }
            )
        elif kind == "type":
            actions.append(
                {
                    "tool": "type_text",
                    "arguments": {"text": require_str(item.get("text"), "text", MAX_TEXT_CHARS)},
                    "element": element,
                }
            )
        elif kind == "set":
            actions.append(
                {
                    "tool": "set_value",
                    "arguments": {"value": require_str(item.get("value"), "value", MAX_TEXT_CHARS)},
                    "element": element,
                }
            )
        elif kind == "key":
            key = require_str(item.get("key"), "key", 32)
            modifiers = item.get("modifiers", [])
            if not isinstance(modifiers, list) or len(modifiers) > 4 or any(
                m not in MODIFIERS for m in modifiers
            ):
                raise Failed("key modifiers must be drawn from ctrl, alt, shift, meta")
            if modifiers:
                actions.append(
                    {
                        "tool": "hotkey",
                        "arguments": {"keys": [*modifiers, key]},
                        "element": element,
                    }
                )
            else:
                actions.append(
                    {
                        "tool": "press_key",
                        "arguments": {"key": key},
                        "element": element,
                    }
                )
        elif kind == "scroll":
            direction = item.get("direction", "down")
            if direction not in DIRECTIONS:
                raise Failed("scroll direction must be up, down, left or right")
            amount = item.get("amount", 3)
            if not isinstance(amount, int) or not 1 <= amount <= 20:
                raise Failed("scroll amount must be an integer between 1 and 20")
            actions.append(
                {
                    "tool": "scroll",
                    "arguments": {"direction": direction, "amount": amount},
                    "element": element,
                }
            )
        else:
            raise Failed(f"unsupported element action {kind or '(missing)'}")
    return actions


class DriverSession:
    """One short-lived stdio MCP session against the accessibility driver."""

    def __init__(self, display: str) -> None:
        env = dict(os.environ)
        env["DISPLAY"] = display
        # Container startup exports the session bus for PID 1 only; recover it.
        bus_file = "/tmp/rakazo/dbus-session"
        if not env.get("DBUS_SESSION_BUS_ADDRESS") and os.access(bus_file, os.R_OK):
            with open(bus_file, encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    prefix = "export DBUS_SESSION_BUS_ADDRESS="
                    if line.startswith(prefix):
                        env["DBUS_SESSION_BUS_ADDRESS"] = line[len(prefix) :].strip()
                        break
        self.deadline = time.monotonic() + DRIVER_DEADLINE_S
        self.process = subprocess.Popen(
            ["cua-driver", "mcp", "--direct"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        self._buffer = b""
        self.next_id = 1
        self.call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "rakazo", "version": "1"},
        })
        self.notify("notifications/initialized")

    def _remaining(self) -> float:
        return self.deadline - time.monotonic()

    def _send(self, payload: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        if self._remaining() <= 0:
            raise Failed("screen tree driver timed out")
        self.process.stdin.write(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
        self.process.stdin.flush()

    def _read(self) -> dict[str, Any]:
        # A blocking readline would sleep past the deadline mid-line, so wait on the
        # descriptor instead and keep partial reads in a buffer.
        assert self.process.stdout is not None
        descriptor = self.process.stdout.fileno()
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                line, self._buffer = self._buffer[:newline], self._buffer[newline + 1 :]
                try:
                    message = json.loads(line.decode("utf-8", "replace"))
                except ValueError:
                    raise Failed("screen tree driver sent malformed output") from None
                if isinstance(message, dict) and "id" in message:
                    return message
                continue
            remaining = self._remaining()
            if remaining <= 0:
                raise Failed("screen tree driver timed out")
            ready, _, _ = select.select([descriptor], [], [], min(remaining, 1.0))
            if not ready:
                continue
            chunk = os.read(descriptor, 65536)
            if not chunk:
                raise Failed("screen tree driver stopped responding")
            self._buffer += chunk

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        self.next_id += 1
        message = self._read()
        if not isinstance(message, dict) or "error" in message:
            raise Failed(str(message.get("error", {}).get("message", "driver call failed")))
        return message["result"]

    def notify(self, method: str) -> None:
        self._send({"jsonrpc": "2.0", "method": method})

    def tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = self.call("tools/call", {"name": name, "arguments": arguments})
        structured = result.get("structuredContent") or {}
        if structured.get("status") == "refused":
            refusal = structured.get("refusal") or {}
            raise Refused(str(refusal.get("message") or "the element is gone; observe again"))
        if result.get("isError"):
            texts = [
                block.get("text", "")
                for block in result.get("content", [])
                if isinstance(block, dict) and block.get("type") == "text"
            ]
            raise Failed(" ".join(texts).strip()[:500] or f"{name} failed")
        return structured

    def close(self) -> None:
        try:
            if self.process.stdin:
                self.process.stdin.close()
            self.process.wait(timeout=5)
        except Exception:
            try:
                self.process.kill()
            except Exception:
                pass


def active_window(session: DriverSession) -> dict[str, Any]:
    """The topmost on-screen window on this display: what a screenshot would show."""
    desktop = session.tool("get_accessibility_tree", {})
    windows = desktop.get("windows") or []
    on_screen = [w for w in windows if isinstance(w, dict) and w.get("is_on_screen")]
    if not on_screen:
        raise Failed("no window is open on this display")
    def rank(window: dict[str, Any]) -> tuple[int, int]:
        bounds = window.get("bounds") or {}
        return (
            int(window.get("z_index") or 0),
            int(bounds.get("width") or 0) * int(bounds.get("height") or 0),
        )
    chosen = max(on_screen, key=rank)
    pid = chosen.get("pid")
    window_id = chosen.get("window_id")
    if not isinstance(pid, int) or not isinstance(window_id, int):
        raise Failed("the active window cannot be addressed")
    return {"pid": pid, "window_id": window_id, "title": str(chosen.get("title") or "")}


def observe(
    session: DriverSession,
    target: dict[str, Any],
    query: str | None,
) -> dict[str, Any]:
    state = session.tool("get_window_state", {
        "pid": target["pid"],
        "window_id": target["window_id"],
        "max_elements": MAX_ELEMENTS,
        "include_screenshot": False,
        **({"query": query} if query else {}),
    })
    return state


def bound_tree(tree: str) -> tuple[str, bool]:
    if len(tree) <= MAX_TREE_CHARS:
        return tree, False
    return tree[:MAX_TREE_CHARS], True


def tree_rows(tree: str) -> dict[int, str]:
    rows: dict[int, str] = {}
    for line in tree.split("\n"):
        match = re.search(r"\[(\d+)\]\s?(.*)$", line.strip())
        if match:
            rows[int(match.group(1))] = match.group(2).strip()
    return rows


def check_expected_rows(state: dict[str, Any], expected: Any) -> None:
    """Each action's row must still read as it did when the caller last observed."""
    if not isinstance(expected, dict):
        return
    rows = tree_rows(str(state.get("tree_markdown") or ""))
    for key, wanted in expected.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            raise Failed("expectedRows keys must be element numbers")
        if rows.get(number) != (wanted if isinstance(wanted, str) else None):
            raise Refused(
                f"element [{number}] changed since the last observation ({wanted!r}); observe again"
            )


def main() -> None:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise Failed("request must be a JSON object")
    except (json.JSONDecodeError, Failed) as error:
        die(1, error=str(error))
    display = request.get("display") or os.environ.get("DISPLAY") or ":1"
    query_raw = request.get("query")
    query = None
    if query_raw is not None:
        query = require_str(query_raw, "query", MAX_QUERY_CHARS)
    try:
        actions = parse_actions(request.get("actions"))
    except Failed as error:
        die(1, error=str(error))

    session = None
    try:
        session = DriverSession(display)
        target = active_window(session)
        state = observe(session, target, None if actions else query)
        # Chromium populates its accessibility tree a moment after launch; one retry
        # turns a just-opened window from a refusal into a usable read.
        if not str(state.get("tree_markdown") or "").strip():
            time.sleep(1.0)
            state = observe(session, target, None if actions else query)
        snapshot_id = state.get("snapshot_id")
        tree_before = str(state.get("tree_markdown") or "")
        if not tree_before.strip():
            raise Failed("the active window exposes no readable elements")
        if actions and state.get("returned_element_count") in (None, 0):
            raise Failed("the active window exposes no addressable elements")
        if actions:
            check_expected_rows(state, request.get("expectedRows"))
        results: list[dict[str, Any]] = []
        popup_window_id = None
        for index, action in enumerate(actions):
            if action["tool"] is None:
                time.sleep(action["arguments"]["ms"] / 1000)
                results.append({"index": index, "ok": True, "note": "waited"})
                continue
            arguments = dict(action["arguments"])
            arguments["element_token"] = f"{snapshot_id}:{action['element']}"
            if action["tool"] in ("type_text", "press_key", "hotkey", "scroll"):
                arguments["pid"] = target["pid"]
            structured = session.tool(action["tool"], arguments)
            popup = structured.get("popup") or {}
            if isinstance(popup, dict) and isinstance(popup.get("window_id"), int):
                popup_window_id = popup["window_id"]
            results.append({"index": index, "ok": True})
        observe_error = None
        if actions:
            time.sleep(SETTLE_MS / 1000)
            # A click that opened a menu names the popup: show the menu, not the window under it.
            final_target = (
                {**target, "window_id": popup_window_id} if popup_window_id else target
            )
            try:
                state = observe(session, final_target, query)
                tree, truncated = bound_tree(str(state.get("tree_markdown") or ""))
                if not tree.strip():
                    raise Failed("the active window exposes no readable elements")
                observe_error = None
            except (Refused, Failed) as error:
                # The actions ran; report them with why the screen could not be re-read, the
                # way the host-screen runner does, instead of hiding what already completed.
                state = {}
                tree, truncated = "", False
                observe_error = str(error)
        else:
            tree, truncated = bound_tree(str(state.get("tree_markdown") or ""))
        json.dump(
            {
                "ok": True,
                "window": {
                    "pid": target["pid"],
                    "windowId": target["window_id"],
                    "title": str(state.get("window_title") or target["title"]),
                },
                "snapshotId": state.get("snapshot_id"),
                "tree": tree,
                "truncated": bool(truncated or state.get("truncated")),
                "elements": state.get("returned_element_count"),
                "actions": results,
                **({"popupWindowId": popup_window_id} if popup_window_id else {}),
                **({"observeError": observe_error} if observe_error else {}),
            },
            sys.stdout,
            separators=(",", ":"),
        )
        sys.stdout.write("\n")
    except Refused as refusal:
        die(2, error=str(refusal), refusal="stale_element")
    except Failed as failure:
        die(2, error=str(failure))
    except FileNotFoundError:
        die(2, error="the screen tree driver is not installed")
    finally:
        if session:
            session.close()


if __name__ == "__main__":
    main()
