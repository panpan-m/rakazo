import { describe, expect, it } from "vitest";
import { MEMORY_PROVIDER_SETTINGS, memoryProviderSettings } from "./registry";
import {
  SERENITY_ENDPOINT_PLACEHOLDER,
  serenityConnectionDraft,
  serenityEndpointError,
} from "./serenity-settings";

describe("memory provider registry", () => {
  it("registers Hindsight with a settings form and self-hosted label", () => {
    const registration = memoryProviderSettings("hindsight");
    expect(registration?.name).toBe("Hindsight");
    expect(registration?.SettingsForm).toBeTruthy();
    expect(
      registration?.connectedLabel({
        provider: "hindsight",
        settings: { baseUrl: "http://localhost:8888" },
        defaultMemoryScope: "isolated",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("Self-hosted (http://localhost:8888)");
    expect(MEMORY_PROVIDER_SETTINGS.some((entry) => entry.id === "hindsight")).toBe(true);
  });
});

describe("Serenity memory provider settings", () => {
  it("requires an explicit endpoint and leaves URL validity to the backend", () => {
    expect(serenityEndpointError("")).toBe("required");
    expect(serenityEndpointError("   ")).toBe("required");
    expect(serenityEndpointError("not a url")).toBeNull();
    expect(serenityEndpointError("ftp://serenity.example.test/mcp")).toBeNull();
    expect(serenityEndpointError("https://user:pass@serenity.example.test/mcp")).toBeNull();
    expect(serenityEndpointError("https://serenity.example.test/mcp?x=1")).toBeNull();
    expect(serenityEndpointError(SERENITY_ENDPOINT_PLACEHOLDER)).toBeNull();

    expect(
      serenityConnectionDraft({
        endpoint: "",
        token: "serenity_token",
        brainLabel: "",
        allowWrites: false,
      }),
    ).toEqual({ ok: false, error: "required" });

    expect(
      serenityConnectionDraft({
        endpoint: "not a url",
        token: "serenity_token",
        brainLabel: "",
        allowWrites: false,
      }),
    ).toEqual({
      ok: true,
      draft: {
        settings: { endpoint: "not a url", allowWrites: "false" },
        credentials: { token: "serenity_token" },
      },
    });

    expect(
      serenityConnectionDraft({
        endpoint: SERENITY_ENDPOINT_PLACEHOLDER,
        token: "sk_live_example",
        brainLabel: " personal ",
        allowWrites: true,
      }),
    ).toEqual({
      ok: true,
      draft: {
        settings: {
          endpoint: "https://serenity.sire.run/mcp",
          allowWrites: "true",
          brainLabel: "personal",
        },
        credentials: { token: "sk_live_example" },
      },
    });
  });
});
