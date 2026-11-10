// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  connectProvider: vi.fn(),
  disconnectProvider: vi.fn(),
  setDefaultScope: vi.fn(),
}));
vi.mock("../lib/space-rpc", () => ({
  useSpaceRpc: () => ({ memory }),
}));
vi.mock("./KnowledgeSection", () => ({ SpaceMemorySection: () => null }));

import { MemorySettingsOverlay } from "./MemorySettingsOverlay";

const connected = {
  provider: "hindsight",
  settings: { baseUrl: "http://localhost:8888" },
  defaultMemoryScope: "isolated" as const,
  updatedAt: "2026-11-10T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onConfigChange = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Macro-compiled copy reads through @lingui/core; empty messages fall back to the source text.
  i18n.loadAndActivate({ locale: "en", messages: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  memory.connectProvider.mockResolvedValue(connected);
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(config: Parameters<typeof MemorySettingsOverlay>[0]["config"]) {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <MemorySettingsOverlay
          embedded
          onClose={() => undefined}
          config={config}
          onConfigChange={onConfigChange}
        />
      </I18nProvider>,
    ),
  );
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("MemorySettingsOverlay", () => {
  it("offers Hindsight and connects a self-hosted base URL without a token", async () => {
    await render(null);
    // With no provider connected yet, the single action opens the provider picker.
    const open = container.querySelector("button");
    expect(open).toBeTruthy();
    await click(open as HTMLButtonElement);

    const select = container.querySelector("select");
    expect(select).toBeTruthy();
    const hindsight = [...(select?.options ?? [])].find((entry) => entry.value === "hindsight");
    expect(hindsight).toBeTruthy();

    await act(async () => {
      (select as HTMLSelectElement).value = "hindsight";
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const baseUrl = container.querySelector<HTMLInputElement>("input");
    expect(baseUrl).toBeTruthy();
    await act(async () => {
      // React's controlled input reads through the native value setter, not the property.
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(baseUrl as HTMLInputElement, "http://localhost:8888");
      baseUrl?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The form's Connect button follows the provider form.
    const connect = [...container.querySelectorAll("button")].at(-1);
    expect(connect).toBeTruthy();
    expect((connect as HTMLButtonElement).disabled).toBe(false);
    await click(connect as HTMLButtonElement);

    expect(memory.connectProvider).toHaveBeenCalledWith({
      provider: "hindsight",
      settings: { baseUrl: "http://localhost:8888" },
      credentials: {},
      defaultMemoryScope: "isolated",
    });
    expect(onConfigChange).toHaveBeenCalledWith(connected);
  });

  it("labels a connected Hindsight configuration as self-hosted", async () => {
    await render(connected);
    expect(container.textContent).toContain("Self-hosted (http://localhost:8888)");
  });
});
