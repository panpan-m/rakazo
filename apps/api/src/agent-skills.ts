import { ORPCError } from "@orpc/server";
import { BUILTIN_AGENT_SKILLS } from "@rakazo/adapters";
import type {
  Actor,
  AgentSkill,
  AgentSkillCatalogEntry,
  AgentSkillSource,
} from "@rakazo/contracts";
import type { SkillSource } from "@rakazo/core";
import {
  buildSkillMd,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  AVAILABILITY_SELECT,
  availableInSpace,
  botVisibleSkillsWhere,
  IsolationError,
  isUniqueViolation,
  spaceAvailability,
} from "@rakazo/db";
import { assertNameFreeWhereAvailable, lockOwner, userAddedAvailability } from "./availability.js";

const SKILL_ACCESS_SELECT = { select: { botId: true } } as const;

const SKILL_INCLUDES = {
  availableIn: AVAILABILITY_SELECT,
  assignments: SKILL_ACCESS_SELECT,
} as const;

type AgentSkillRow = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string | null;
  allSpaces: boolean;
  allBots: boolean;
  availableIn?: Array<{ spaceId: string }>;
  assignments?: Array<{ botId: string }>;
  name: string;
  description: string;
  content: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
};

function asSource(value: string): AgentSkillSource {
  if (value === "builtin" || value === "plugin" || value === "user") return value;
  return "user";
}

export function mapAgentSkill(row: AgentSkillRow): AgentSkill {
  const source = asSource(row.source);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: isSkillReadOnly(source as SkillSource),
    availability: spaceAvailability(row),
    owner: row.botId ? { kind: "bot", botId: row.botId } : { kind: "space" },
    access: row.botId
      ? undefined
      : { allBots: row.allBots, botIds: (row.assignments ?? []).map((entry) => entry.botId) },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A bot skill may share a name with a space skill (it shadows it for that bot), but not
 * with another of the same bot's skills; the owner lock keeps two claims from racing. */
async function assertBotSkillNameFree(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  name: string,
  botId: string,
  excludeId?: string,
) {
  await lockOwner(tx, actor.userId, "names:skill");
  const clash = await tx.agentSkill.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId,
      name: { equals: name, mode: "insensitive" },
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
}

function builtinCatalog(): AgentSkill[] {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
}

export function resolveSkillContent(input: {
  content?: string;
  name?: string;
  description?: string;
  body?: string;
  prior?: { content: string };
}): { name: string; description: string; content: string } {
  const ensureContentLimit = (content: string): string => {
    if (content.length > 100_000) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Skill content must be at most 100000 characters.",
      });
    }
    return content;
  };

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) {
      throw new ORPCError("BAD_REQUEST", { message: parsed.error });
    }
    return {
      name: parsed.name,
      description: parsed.description,
      content: ensureContentLimit(buildSkillMd(parsed)),
    };
  }

  const priorParsed = input.prior ? parseSkillMd(input.prior.content) : null;
  if (priorParsed && "error" in priorParsed) {
    throw new ORPCError("BAD_REQUEST", { message: priorParsed.error });
  }

  const name = (input.name ?? priorParsed?.name ?? "").trim();
  const description = (input.description ?? priorParsed?.description ?? "").trim();
  const body = input.body ?? priorParsed?.body ?? "";
  if (!name || !description) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Provide content (SKILL.md) or name + description (+ optional body)",
    });
  }
  let content: string;
  try {
    content = buildSkillMd({
      name,
      description,
      body,
      frontmatter: priorParsed && !("error" in priorParsed) ? priorParsed.frontmatter : undefined,
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid skill fields.",
    });
  }
  const validated = parseSkillMd(content);
  if ("error" in validated) {
    throw new ORPCError("BAD_REQUEST", { message: validated.error });
  }
  return {
    name: validated.name,
    description: validated.description,
    content: ensureContentLimit(buildSkillMd(validated)),
  };
}

export function createAgentSkillsService(prisma: PrismaClient) {
  async function owned(actor: Actor, skillId: string) {
    const row = await prisma.agentSkill.findFirst({
      where: { id: skillId, ...availableInSpace(actor) },
      include: SKILL_INCLUDES,
    });
    if (!row) throw new IsolationError();
    return row;
  }

  async function botInSpace(actor: Actor, botId: string) {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId },
      select: { id: true },
    });
    if (!bot) throw new IsolationError();
  }

  return {
    async list(actor: Actor): Promise<Omit<AgentSkill, "content">[]> {
      const rows = await prisma.agentSkill.findMany({
        where: availableInSpace(actor),
        omit: { files: true },
        include: SKILL_INCLUDES,
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return mergeBuiltinSkills(builtinCatalog(), rows.map(mapAgentSkill)).map(
        ({ content: _content, ...entry }) => entry,
      );
    },

    async listWithContent(actor: Actor, botId?: string): Promise<AgentSkill[]> {
      const rows = await prisma.agentSkill.findMany({
        where: botId ? botVisibleSkillsWhere(actor, botId) : availableInSpace(actor),
        omit: { files: true },
        include: SKILL_INCLUDES,
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      // A bot's own skill shadows a same-named space skill before builtins are merged.
      const visible = botId
        ? dedupeByOwnerPreference(rows).map(mapAgentSkill)
        : rows.map(mapAgentSkill);
      return mergeBuiltinSkills(builtinCatalog(), visible);
    },

    async get(actor: Actor, input: { skillId?: string; name?: string }): Promise<AgentSkill> {
      if (input.skillId?.startsWith("builtin:")) {
        const builtin = builtinCatalog().find((skill) => skill.id === input.skillId);
        if (!builtin) throw new IsolationError();
        return builtin;
      }
      if (input.skillId) {
        return mapAgentSkill(await owned(actor, input.skillId));
      }
      const name = input.name?.trim() ?? "";
      const rows = await prisma.agentSkill.findMany({
        where: availableInSpace(actor),
        include: SKILL_INCLUDES,
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      const row = findSkillByName(rows, name);
      if (row) return mapAgentSkill(row);
      const builtin = findSkillByName(builtinCatalog(), name);
      if (!builtin) throw new IsolationError();
      return builtin;
    },

    async create(
      actor: Actor,
      input: {
        content?: string;
        name?: string;
        description?: string;
        body?: string;
        botId?: string;
      },
    ): Promise<AgentSkill> {
      const resolved = resolveSkillContent(input);
      if (builtinCatalog().some((s) => s.name.toLowerCase() === resolved.name.toLowerCase())) {
        throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
      }
      if (input.botId) await botInSpace(actor, input.botId);
      try {
        const row = await prisma.$transaction(async (tx) => {
          if (input.botId) {
            await assertBotSkillNameFree(tx, actor, resolved.name, input.botId);
          } else {
            await assertNameFreeWhereAvailable(
              tx,
              "skill",
              actor,
              resolved.name,
              userAddedAvailability(actor),
            );
          }
          return tx.agentSkill.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              // A bot's own skill never leaves its bot, so it has no space availability to keep.
              ...(input.botId ? { botId: input.botId, allSpaces: false } : { allSpaces: true }),
              name: resolved.name,
              description: resolved.description,
              content: resolved.content,
              source: "user",
            },
            include: SKILL_INCLUDES,
          });
        });
        return mapAgentSkill(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
        }
        throw error;
      }
    },

    async update(
      actor: Actor,
      input: {
        skillId: string;
        content?: string;
        name?: string;
        description?: string;
        body?: string;
        botId?: string | null;
      },
    ): Promise<AgentSkill> {
      const existing = await owned(actor, input.skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const moving = input.botId !== undefined && input.botId !== existing.botId;
      const targetBotId = moving ? input.botId : existing.botId;
      if (moving && input.botId) await botInSpace(actor, input.botId);
      const resolved = resolveSkillContent({ ...input, prior: existing });
      const renamed = !findSkillByName([existing], resolved.name);
      if (
        renamed &&
        builtinCatalog().some((s) => s.name.toLowerCase() === resolved.name.toLowerCase())
      ) {
        throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
      }
      // Mutate only owner-scoped user rows (never builtin/plugin), even if source was tampered.
      try {
        const updated = await prisma.$transaction(async (tx) => {
          if (targetBotId) {
            if (renamed || moving)
              await assertBotSkillNameFree(tx, actor, resolved.name, targetBotId, existing.id);
          } else if (renamed || moving) {
            await assertNameFreeWhereAvailable(
              tx,
              "skill",
              actor,
              resolved.name,
              spaceAvailability({ ...existing, allSpaces: moving ? false : existing.allSpaces }),
              existing.id,
            );
          }
          if (moving) {
            // Arriving at a bot, the skill drops its space availability and per-bot assignments;
            // returning to the space, it becomes available to every bot again.
            await tx.agentSkillSpace.deleteMany({ where: { skillId: existing.id } });
            await tx.agentSkillBot.deleteMany({ where: { skillId: existing.id } });
          }
          return tx.agentSkill.updateMany({
            where: { id: existing.id, ...availableInSpace(actor), source: "user" },
            data: {
              name: resolved.name,
              description: resolved.description,
              content: resolved.content,
              ...(moving ? { botId: targetBotId, allSpaces: false, allBots: true } : {}),
            },
          });
        });
        if (updated.count !== 1) throw new IsolationError();
      } catch (error) {
        if (error instanceof IsolationError) throw error;
        if (isUniqueViolation(error)) {
          throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
        }
        throw error;
      }
      return mapAgentSkill(await owned(actor, existing.id));
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const existing = await owned(actor, skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const deleted = await prisma.agentSkill.deleteMany({
        where: { id: existing.id, ...availableInSpace(actor), source: "user" },
      });
      if (deleted.count !== 1) throw new IsolationError();
      return { ok: true };
    },

    /** The catalog one bot sees: its own skills, the space skills granted to it, then builtins. */
    async forBot(actor: Actor, botId: string): Promise<AgentSkillCatalogEntry[]> {
      await botInSpace(actor, botId);
      const rows = await prisma.agentSkill.findMany({
        where: botVisibleSkillsWhere(actor, botId),
        omit: { files: true },
        include: SKILL_INCLUDES,
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return mergeBuiltinSkills(
        builtinCatalog(),
        dedupeByOwnerPreference(rows).map(mapAgentSkill),
      ).map(({ content: _content, ...entry }) => entry);
    },

    /** Set which bots a space skill is for; assignments stay while allBots restores them later. */
    async setAccess(
      actor: Actor,
      input: { skillId: string; allBots: boolean; botIds: string[] },
    ): Promise<AgentSkillCatalogEntry> {
      const existing = await owned(actor, input.skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      if (existing.botId) {
        throw new ORPCError("BAD_REQUEST", {
          message: "A bot's own skill is only for that bot.",
        });
      }
      const owner = { spaceId: actor.spaceId, userId: actor.userId };
      const botIds = [...new Set(input.botIds)];
      await prisma.$transaction(async (tx) => {
        await tx.agentSkill.update({
          where: { id: existing.id },
          data: { allBots: input.allBots },
        });
        if (!input.allBots) {
          const bots = await tx.bot.findMany({
            where: { ...owner, id: { in: botIds } },
            select: { id: true },
          });
          if (bots.length !== botIds.length) throw new IsolationError();
          const previous = await tx.agentSkillBot.findMany({
            where: { ...owner, skillId: existing.id },
            select: { botId: true },
          });
          const removed = previous.map((row) => row.botId).filter((id) => !botIds.includes(id));
          await tx.agentSkillBot.deleteMany({
            where: { ...owner, skillId: existing.id, botId: { in: removed } },
          });
          await tx.agentSkillBot.createMany({
            data: botIds.map((botId) => ({ ...owner, botId, skillId: existing.id })),
            skipDuplicates: true,
          });
        }
      });
      const { content: _content, ...entry } = mapAgentSkill(await owned(actor, existing.id));
      return entry;
    },
  };
}

/** Same-named rows collapse to the one the bot itself owns; other bots' rows never reach here. */
function dedupeByOwnerPreference(rows: AgentSkillRow[]): AgentSkillRow[] {
  const seen = new Set<string>();
  const preferred = [...rows].sort((a, b) => Number(b.botId !== null) - Number(a.botId !== null));
  return preferred.filter((row) => {
    const key = row.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type AgentSkillsService = ReturnType<typeof createAgentSkillsService>;
