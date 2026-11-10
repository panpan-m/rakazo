import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";
import { fetchFresh } from "@rakazo/core/query";
import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SectionHeading,
  Skeleton,
  Switch,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { NEW_SKILL_TEMPLATE } from "../KnowledgeSection";

const NO_SKILLS: AgentSkillCatalogEntry[] = [];
const NO_BOTS: { id: string }[] = [];

/** The user's space skills this bot may use; own skills are always on. */
function spaceSkillOn(skill: AgentSkillCatalogEntry, botId: string): boolean {
  if (skill.owner?.kind === "bot") return skill.owner.botId === botId;
  return skill.access ? skill.access.allBots || skill.access.botIds.includes(botId) : true;
}

/** One card whose know-how is a scrollable canvas of its own, so reading never grows the panel. */
function OwnSkillCard({
  skill,
  busy,
  onShare,
}: {
  skill: AgentSkillCatalogEntry;
  busy: boolean;
  onShare: () => void;
}) {
  const queries = useSpaceQueries();
  const full = useQuery(queries.agentSkills.get.queryOptions({ input: { skillId: skill.id } }));
  const parsed = full.data ? parseSkillMd(full.data.content) : null;
  const body = parsed && !("error" in parsed) ? parsed.body.trim() : "";
  return (
    <Card size="sm" data-testid="bot-own-skill">
      <CardHeader>
        <CardTitle className="truncate" dir="auto">
          {skill.name}
        </CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={busy}
            onClick={onShare}
            className="h-7 px-2 text-label font-normal"
          >
            <Trans>Share with space</Trans>
          </Button>
        </CardAction>
        <CardDescription className="truncate" dir="auto">
          {skill.description}
        </CardDescription>
      </CardHeader>
      {body ? (
        <CardContent>
          <div
            className="max-h-44 overflow-y-auto rounded-lg bg-muted/60 p-2.5 font-mono text-body-sm leading-relaxed whitespace-pre-wrap text-foreground"
            dir="auto"
          >
            {body}
          </div>
        </CardContent>
      ) : null}
      {!full.data && !full.isError ? (
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      ) : null}
    </Card>
  );
}

/** Its own skills as cards, and the space's skills behind their own scrollable canvas. */
export function BotSkillsSection({ botId }: { botId: string }) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.agentSkills.list.queryOptions();
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  const botsQuery = useQuery(queries.bots.list.queryOptions());
  const bots = (botsQuery.data ?? NO_BOTS).filter(
    (bot) => !("archivedAt" in bot) || !bot.archivedAt,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  const skills = (listQuery.data ?? NO_SKILLS).filter((skill) => skill.source !== "plugin");
  const own = skills.filter((skill) => skill.owner?.kind === "bot" && skill.owner.botId === botId);
  const spaceSkills = skills.filter(
    (skill) => skill.source === "user" && skill.owner?.kind !== "bot",
  );
  const shadowedHere = new Set(own.map((skill) => skill.name.trim().toLowerCase()));

  async function refresh() {
    try {
      await fetchFresh(queryClient, list);
    } catch {
      setError(t`Could not load`);
    }
  }

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Could not save skill`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleSpaceSkill(skill: AgentSkillCatalogEntry) {
    const access = skill.access ?? { allBots: true, botIds: [] };
    const chosen = access.allBots ? bots.map((bot) => bot.id) : access.botIds;
    const next = chosen.includes(botId) ? chosen.filter((id) => id !== botId) : [...chosen, botId];
    await run(() => rpc.agentSkills.setAccess({ skillId: skill.id, allBots: false, botIds: next }));
  }

  return (
    <div data-testid="bot-skills-section" className="space-y-4">
      <SectionHeading variant="label">
        <Trans>Skills</Trans>
      </SectionHeading>
      {error ? <div className="text-body-sm text-destructive">{error}</div> : null}
      {listQuery.isPending ? <Skeleton className="h-10 w-full" /> : null}
      {own.length || creating ? (
        <div className="space-y-2" data-testid="bot-own-skills">
          <SectionHeading variant="label">
            <Trans>Its own</Trans>
          </SectionHeading>
          {own.map((skill) => (
            <OwnSkillCard
              key={skill.id}
              skill={skill}
              busy={busy}
              onShare={() =>
                void run(() => rpc.agentSkills.update({ skillId: skill.id, botId: null }))
              }
            />
          ))}
          {creating ? (
            <Card size="sm" data-testid="bot-new-skill-card">
              <CardHeader>
                <CardTitle>
                  <Trans>New skill</Trans>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Textarea
                  aria-label={t`SKILL.md`}
                  disabled={busy}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={Math.min(12, Math.max(6, draft.split("\n").length + 1))}
                  className="w-full font-mono text-body-sm leading-relaxed"
                  dir="auto"
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    type="button"
                    size="sm"
                    disabled={busy || !draft.trim()}
                    onClick={() =>
                      void run(async () => {
                        await rpc.agentSkills.create({ content: draft, botId });
                        setCreating(false);
                        setDraft("");
                      })
                    }
                  >
                    <Trans>Save</Trans>
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setCreating(false);
                      setDraft("");
                    }}
                    className="text-muted-foreground"
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
      {!creating ? (
        <Button
          variant="outline"
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => {
            setDraft(NEW_SKILL_TEMPLATE);
            setCreating(true);
          }}
          className="gap-1"
        >
          <Plus aria-hidden="true" className="size-4" />
          <Trans>New skill</Trans>
        </Button>
      ) : null}
      {spaceSkills.length ? (
        <div className="space-y-2" data-testid="bot-space-skills">
          <SectionHeading variant="label">
            <Trans>Space skills</Trans>
          </SectionHeading>
          <div
            data-testid="bot-space-canvas"
            className="max-h-72 divide-y overflow-y-auto rounded-xl ring-1 ring-foreground/10"
          >
            {spaceSkills.map((skill) => {
              const on = spaceSkillOn(skill, botId);
              const shadowed = shadowedHere.has(skill.name.trim().toLowerCase());
              return (
                <div
                  key={skill.id}
                  className="flex min-h-11 items-center gap-2.5 px-3 py-1.5"
                  data-testid="bot-space-skill"
                >
                  <Switch
                    checked={on}
                    disabled={busy || shadowed}
                    aria-label={skill.name}
                    onCheckedChange={() => void toggleSpaceSkill(skill)}
                  />
                  <span className="min-w-0 flex-1" dir="auto">
                    <span className="block truncate text-body text-foreground">{skill.name}</span>
                    {skill.description ? (
                      <span className="block truncate text-caption text-muted-foreground">
                        {skill.description}
                      </span>
                    ) : null}
                  </span>
                  {shadowed ? (
                    <span className="shrink-0 text-caption text-muted-foreground">
                      <Trans>Own version</Trans>
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
