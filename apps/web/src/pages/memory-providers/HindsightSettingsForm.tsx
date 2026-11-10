import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

function parseableBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export function HindsightSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const baseUrlId = useId();
  const baseUrlErrorId = useId();
  const tokenId = useId();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const touched = baseUrl.trim().length > 0;
  const baseUrlValid = parseableBaseUrl(baseUrl.trim());
  const tokenValid = token.trim().length === 0 || token.trim().length >= 8;
  const ready = touched && baseUrlValid && tokenValid;

  async function connect() {
    if (!ready) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: { baseUrl: baseUrl.trim() },
      credentials: token.trim() ? { token: token.trim() } : {},
    };
    if (await onConnect(draft)) setToken("");
  }

  return (
    <>
      <Field className="mt-4" data-invalid={touched && !baseUrlValid ? true : undefined}>
        <FieldLabel htmlFor={baseUrlId}>
          <Trans>Base URL</Trans>
        </FieldLabel>
        <Input
          id={baseUrlId}
          value={baseUrl}
          required
          disabled={busy}
          aria-invalid={touched && !baseUrlValid ? true : undefined}
          aria-describedby={touched && !baseUrlValid ? baseUrlErrorId : undefined}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://localhost:8888"
          autoComplete="off"
        />
        {touched && !baseUrlValid ? (
          <FieldError id={baseUrlErrorId}>
            <Trans>Enter an http(s) URL without credentials.</Trans>
          </FieldError>
        ) : null}
      </Field>

      <Field className="mt-4" data-invalid={tokenValid ? undefined : true}>
        <FieldLabel htmlFor={tokenId}>
          <Trans>Access token</Trans>
        </FieldLabel>
        <Input
          id={tokenId}
          value={token}
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
          type="password"
          autoComplete="new-password"
          maxLength={4096}
        />
        {!tokenValid ? (
          <FieldError>
            <Trans>Use at least 8 characters.</Trans>
          </FieldError>
        ) : null}
      </Field>

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || !ready}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
