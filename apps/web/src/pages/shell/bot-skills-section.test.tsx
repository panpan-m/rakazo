// @vitest-environment jsdom

import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setAccess: vi.fn(async () => ({})),
}));
type BotRow = { id: string; name: string; color: string; archivedAt: string | null };
const botsApi = vi.hoisted(() => ({ list: vi.fn(async () => [] as BotRow[]) }));

vi.mock("../../lib/rpc", () => {
  const client = { agentSkills: api, bots: botsApi };
  return {
    rpc: client,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

import { BotSkillsSection } from "./bot-skills-section";

function skill(entry: Partial<AgentSkillCatalogEntry> & { id: string; name: string }) {
  return {
    description: "",
    source: "user",
    readOnly: false,
    owner: { kind: "space" },
    access: { allBots: true, botIds: [] },
    ...entry,
  } as AgentSkillCatalogEntry;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function render(skills: AgentSkillCatalogEntry[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockImplementation(async () => skills);
  botsApi.list.mockImplementation(async () => [
    { id: "bot-1", name: "Ada", color: "#111", archivedAt: null },
    { id: "bot-2", name: "Belle", color: "#222", archivedAt: null },
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <BotSkillsSection botId="bot-1" />
      </QueryClientProvider>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

it("lists the bot's own skills as cards with a scrollable content canvas", async () => {
  api.get.mockImplementation(async () => ({
    id: "own-1",
    name: "Mine",
    description: "d",
    content: "---\nname: Mine\ndescription: d\n---\n\nStep one.\nStep two.",
    source: "user",
    readOnly: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }));
  await render([
    skill({ id: "own-1", name: "Mine", owner: { kind: "bot", botId: "bot-1" } }),
    skill({ id: "other", name: "Theirs", owner: { kind: "bot", botId: "bot-2" } }),
  ]);
  expect(container!.textContent).toContain("Mine");
  expect(container!.textContent).not.toContain("Theirs");
  const card = container!.querySelector('[data-testid="bot-own-skill"]');
  expect(card).toBeTruthy();
  // The card's know-how arrives with its own get; wait for the canvas it fills.
  await vi.waitFor(() => {
    const canvas = card!.querySelector(".overflow-y-auto");
    expect(canvas?.getAttribute("class")).toContain("max-h-44");
    expect(canvas?.textContent).toContain("Step one.");
  });
});

it("shares one of the bot's own skills with the space", async () => {
  await render([skill({ id: "own-1", name: "Mine", owner: { kind: "bot", botId: "bot-1" } })]);
  const share = [...container!.querySelectorAll("button")].find(
    (node) => node.textContent === "Share with space",
  );
  expect(share).toBeTruthy();
  await act(async () => {
    share!.click();
  });
  expect(api.update).toHaveBeenCalledWith({ skillId: "own-1", botId: null });
});

it("toggles a space skill off for this bot and keeps the other bot on", async () => {
  await render([skill({ id: "space-1", name: "Shared" })]);
  const canvas = container!.querySelector('[data-testid="bot-space-canvas"]');
  expect(canvas?.getAttribute("class")).toContain("overflow-y-auto");
  const toggle = container!.querySelector('[data-testid="bot-space-skill"] [data-slot="switch"]');
  expect(toggle?.hasAttribute("data-checked")).toBe(true);
  await act(async () => {
    toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(api.setAccess).toHaveBeenCalledWith({
    skillId: "space-1",
    allBots: false,
    botIds: ["bot-2"],
  });
});

it("marks a space skill the bot's own skill shadows", async () => {
  await render([
    skill({ id: "own-1", name: "export", owner: { kind: "bot", botId: "bot-1" } }),
    skill({ id: "space-1", name: "export" }),
  ]);
  const shadowed = container!.querySelector('[data-testid="bot-space-skill"]');
  expect(shadowed?.textContent).toContain("Own version");
});

it("renders nothing to toggle when the space has no user skills", async () => {
  await render([]);
  expect(container!.querySelector('[data-testid="bot-space-skill"]')).toBeNull();
});
