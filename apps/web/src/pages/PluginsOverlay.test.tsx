// @vitest-environment jsdom

import type { PluginMarketplaceEntry } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginsOverlay } from "./PluginsOverlay";

const api = vi.hoisted(() => ({
  connections: {
    catalog: vi.fn(),
    list: vi.fn(),
    tools: vi.fn(),
  },
  capabilities: { list: vi.fn(), catalogSearch: vi.fn(), sourcePresets: vi.fn() },
  mcp: { servers: { list: vi.fn() }, assignments: { list: vi.fn() } },
  marketplace: { catalog: vi.fn() },
}));

vi.mock("../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../lib/mcp-connect", () => ({ connectMcpOauth: vi.fn() }));
vi.mock("../components/integrations/space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
}));
vi.mock("@lingui/react/macro", () => ({
  Plural: () => null,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));
vi.mock("@rakazo/ui-web", async () => {
  const { createElement, createContext, useContext, useState } = await import("react");
  const container = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  // A minimal tab seam: switching calls onValueChange so controlled tabs follow.
  const TabsValue = createContext<{ value: string; pick: (value: string) => void } | null>(null);
  const tabs = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }) => {
    const [current, setCurrent] = useState(value ?? "apps");
    return createElement(
      TabsValue.Provider,
      {
        value: {
          value: current,
          pick: (next: string) => {
            setCurrent(next);
            onValueChange?.(next);
          },
        },
      },
      children,
    );
  };
  const tabsTrigger = ({ value, children }: { value?: string; children?: ReactNode }) => {
    const ctx = useContext(TabsValue);
    return createElement("button", { onClick: () => ctx?.pick(value ?? "") }, children);
  };
  const tabsContent = ({ value, children }: { value?: string; children?: ReactNode }) => {
    const ctx = useContext(TabsValue);
    return ctx && ctx.value === value ? createElement("div", null, children) : null;
  };
  return Object.fromEntries([
    ...[
      "Badge",
      "Dialog",
      "DialogClose",
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "Disclosure",
      "DropdownMenu",
      "DropdownMenuContent",
      "DropdownMenuItem",
      "DropdownMenuSeparator",
      "DropdownMenuTrigger",
      "Field",
      "FieldDescription",
      "FieldLabel",
      "NativeSelect",
      "NativeSelectOption",
      "SectionHeading",
      "Spinner",
      "TabsList",
    ].map((name) => [name, container]),
    ["Tabs", tabs],
    ["TabsTrigger", tabsTrigger],
    ["TabsContent", tabsContent],
    [
      "Button",
      ({
        children,
        onClick,
        disabled,
        type,
        "aria-label": label,
      }: {
        children?: ReactNode;
        onClick?: () => void;
        disabled?: boolean;
        type?: "button" | "submit";
        "aria-label"?: string;
      }) =>
        createElement(
          "button",
          { type: type ?? "button", onClick, disabled, "aria-label": label },
          children,
        ),
    ],
    [
      "Input",
      (props: {
        value?: string;
        disabled?: boolean;
        placeholder?: string;
        onChange?: () => void;
        "aria-label"?: string;
      }) =>
        createElement("input", {
          value: props.value,
          disabled: props.disabled,
          placeholder: props.placeholder,
          onChange: props.onChange,
          "aria-label": props["aria-label"],
        }),
    ],
  ]);
});

let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.connections.catalog.mockReset().mockResolvedValue([]);
  api.connections.list.mockReset().mockResolvedValue([]);
  api.connections.tools.mockReset().mockResolvedValue([]);
  api.capabilities.list.mockReset().mockResolvedValue([]);
  api.capabilities.sourcePresets.mockReset().mockResolvedValue([]);
  api.capabilities.catalogSearch
    .mockReset()
    .mockImplementation(async (input: { usePublicCatalog?: boolean }) =>
      input.usePublicCatalog
        ? {
            enabled: true,
            results: [
              {
                domain: "canva.example.test",
                name: "Canva",
                description: "",
                pageUrl: null,
                surfaces: [
                  {
                    kind: "mcp",
                    slug: "canva",
                    source: "https://mcp.canva.example.test/mcp",
                    auth: null,
                  },
                ],
              },
            ],
          }
        : { enabled: false, results: [] },
    );
  api.mcp.servers.list.mockReset().mockResolvedValue([]);
  api.mcp.assignments.list.mockReset().mockResolvedValue([]);
  api.marketplace.catalog.mockReset().mockResolvedValue({ entries: [], unavailableRegistries: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function searchBox() {
  return host.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function publicCatalogRow() {
  return Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.startsWith("Search MCP servers for"),
  );
}

function publicSearches() {
  return api.capabilities.catalogSearch.mock.calls.filter(
    (call) => (call[0] as { usePublicCatalog?: boolean }).usePublicCatalog,
  );
}

it("offers the public catalog for a search and sends nothing there until it is picked", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(searchBox().disabled).toBe(false));

  await type(searchBox(), "c");
  expect(publicCatalogRow()).toBeUndefined();

  // Longer than the catalog search accepts: nothing to offer.
  await type(searchBox(), "x".repeat(254));
  expect(publicCatalogRow()).toBeUndefined();

  await type(searchBox(), " canva ");
  expect(host.textContent).toContain("No apps match your search.");
  expect(publicCatalogRow()?.textContent).toBe("Search MCP servers for “canva”");
  expect(publicSearches()).toHaveLength(0);

  await act(async () => publicCatalogRow()?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Canva"));
  expect(host.textContent).toContain("Add MCP server");
  expect(searchBox().value).toBe("canva");
  expect(publicSearches()).toEqual([[{ query: "canva", usePublicCatalog: true }]]);
});

function marketplaceEntry(entry: {
  name: string;
  displayName?: string;
  hasConnector?: boolean;
  skillCount?: number;
}): PluginMarketplaceEntry {
  return {
    id: `test:${entry.name}`,
    name: entry.name,
    displayName: entry.displayName ?? entry.name,
    description: "",
    keywords: [],
    category: null,
    logo: null,
    homepage: null,
    domains: [],
    registry: "test",
    source: `https://github.com/example/${entry.name}`,
    installedSource: `https://github.com/example/${entry.name}`,
    hasConnector: entry.hasConnector ?? false,
    skillCount: entry.skillCount ?? 0,
  };
}

it("keeps skill packs on their own sheet, connectors on Apps", async () => {
  api.marketplace.catalog.mockResolvedValue({
    entries: [
      marketplaceEntry({ name: "aave", displayName: "Aave", hasConnector: true }),
      marketplaceEntry({ name: "pdf", displayName: "Pdf Skills", skillCount: 3 }),
    ],
    unavailableRegistries: [],
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("Aave"));

  const sheets = [...host.querySelectorAll("button")];
  const skillsSheet = sheets.find((button) => button.textContent?.startsWith("Skills"));
  expect(skillsSheet).toBeDefined();
  // Each sheet says how many entries it holds.
  expect(skillsSheet?.textContent).toContain("1");
  expect(sheets.find((button) => button.textContent?.startsWith("Apps"))?.textContent).toContain(
    "1",
  );
  expect(host.textContent).not.toContain("Pdf Skills");

  await act(async () => skillsSheet?.click());
  expect(host.textContent).toContain("Pdf Skills");
  expect(host.textContent).not.toContain("Aave");
});
