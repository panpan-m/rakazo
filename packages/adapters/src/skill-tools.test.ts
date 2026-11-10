import { buildSkillMd, formatSkillsCatalogInstruction, parseSkillMd } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import {
  listAgentSkillRecords,
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "./skill-tools.js";

type Where = {
  spaceId?: string;
  userId?: string;
  botId?: string | null;
  allSpaces?: boolean;
  allBots?: boolean;
  assignments?: { some: { botId: string } };
  availableIn?: { some?: { spaceId: string }; none?: Record<string, never> };
  OR?: Where[];
  AND?: Where[];
};
/** The owner's rows here: added in this space (no fixture is available beyond one). */
function matches(row: Record<string, unknown>, where: Where): boolean {
  if (where.userId && row.userId !== where.userId) return false;
  if (where.spaceId && row.spaceId !== where.spaceId) return false;
  if (where.botId !== undefined && (row.botId ?? null) !== where.botId) return false;
  if (where.allSpaces !== undefined && Boolean(row.allSpaces ?? false) !== where.allSpaces) {
    return false;
  }
  if (where.allBots !== undefined && Boolean(row.allBots ?? true) !== where.allBots) return false;
  const assigned = (row.assignments ?? []) as Array<{ botId: string }>;
  if (
    where.assignments?.some &&
    !assigned.some((entry) => entry.botId === where.assignments?.some.botId)
  ) {
    return false;
  }
  if (where.OR && !where.OR.some((branch) => matches(row, branch))) return false;
  if (where.AND && !where.AND.every((branch) => matches(row, branch))) return false;
  const spaces = (row.availableIn ?? []) as Array<{ spaceId: string }>;
  if (
    where.availableIn?.some &&
    !spaces.some((entry) => entry.spaceId === where.availableIn?.some?.spaceId)
  ) {
    return false;
  }
  if (where.availableIn?.none && spaces.length > 0) return false;
  return true;
}

function makePrisma(rows: Array<Record<string, unknown>> = []) {
  const store = [...rows];
  return {
    agentSkill: {
      findMany: vi.fn(async ({ where }: { where?: Where } = {}) =>
        store.filter((row) => !where || matches(row, where)).map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(async ({ where }: { where: Where & { id: string } }) => {
        const row = store.find((item) => item.id === where.id && matches(item, where));
        return row ? { files: row.files ?? null } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `skill-${store.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          source: "user",
          botId: null,
          ...data,
        };
        store.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const index = store.findIndex((row) => row.id === where.id);
          if (index < 0) throw new Error("missing");
          store[index] = { ...store[index], ...data, updatedAt: new Date() };
          return store[index];
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, string>;
          data: Record<string, unknown>;
        }) => {
          const index = store.findIndex(
            (row) =>
              row.id === where.id &&
              row.spaceId === where.spaceId &&
              row.userId === where.userId &&
              row.source === where.source,
          );
          if (index < 0) return { count: 0 };
          store[index] = { ...store[index], ...data, updatedAt: new Date() };
          return { count: 1 };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = store.findIndex((row) => row.id === where.id);
        if (index < 0) throw new Error("missing");
        const [removed] = store.splice(index, 1);
        return removed;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        const index = store.findIndex(
          (row) =>
            row.id === where.id &&
            row.spaceId === where.spaceId &&
            row.userId === where.userId &&
            row.source === where.source,
        );
        if (index < 0) return { count: 0 };
        store.splice(index, 1);
        return { count: 1 };
      }),
    },
    _store: store,
  };
}

const owner = { spaceId: "ws-1", userId: "user-1" };

describe("skill tools", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it("creates, reads, updates, and deletes user skills", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "1. Summarize yesterday.\n2. List blockers.",
    });
    expect(created).toMatchObject({ ok: true, name: "Daily standup" });
    expect(String(created.hint)).toContain("/Daily standup");

    const read = await skillReadFromTool(prisma as never, owner, { name: "Daily standup" });
    expect(read).toMatchObject({
      name: "Daily standup",
      description: "Prepare standup notes",
      readOnly: false,
    });
    expect(String(read.content)).toContain("Summarize yesterday");

    const updated = await skillUpdateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Updated when-to-use",
    });
    expect(updated).toMatchObject({ ok: true, description: "Updated when-to-use" });

    const deleted = await skillDeleteFromTool(prisma as never, owner, { name: "Daily standup" });
    expect(deleted).toEqual({ ok: true, name: "Daily standup" });
    expect(await skillReadFromTool(prisma as never, owner, { name: "Daily standup" })).toEqual({
      error: "Skill not found.",
    });
  });

  it("lists a skill's reference files and reads one by exact path only", async () => {
    const prisma = makePrisma([
      {
        id: "plugin-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "billing",
        description: "Billing guidance",
        content: buildSkillMd({
          name: "billing",
          description: "Billing guidance",
          body: "See references/rates.md.",
        }),
        source: "plugin",
        files: { "references/rates.md": "Rates table", "notes.txt": "Notes" },
      },
    ]);
    expect(await skillReadFromTool(prisma as never, owner, { name: "billing" })).toMatchObject({
      name: "billing",
      files: ["notes.txt", "references/rates.md"],
    });
    expect(
      await skillReadFromTool(prisma as never, owner, {
        name: "billing",
        file: "./references/rates.md",
      }),
    ).toEqual({ name: "billing", file: "references/rates.md", content: "Rates table" });
    expect(
      await skillReadFromTool(prisma as never, owner, { name: "billing", file: "../secrets.md" }),
    ).toMatchObject({ error: expect.stringContaining("No file") });
  });

  it("preserves extra frontmatter keys on update", async () => {
    const content = buildSkillMd({
      name: "Review PR",
      description: "Review a pull request",
      body: "1. Read the diff.",
      frontmatter: { compatibility: "cursor", "allowed-tools": ["shell"] },
    });
    await skillCreateFromTool(prisma as never, owner, { content });
    await skillUpdateFromTool(prisma as never, owner, {
      name: "Review PR",
      body: "1. Read the diff.\n2. Leave comments.",
    });
    const read = await skillReadFromTool(prisma as never, owner, { name: "Review PR" });
    expect(String(read.content)).toContain("compatibility: cursor");
    expect(String(read.content)).toContain("Leave comments");
  });

  it("renames only via newName, not the name lookup key", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Original",
      description: "Keep name unless newName",
      body: "body",
    });
    const skillId = String(created.id);
    const mistyped = await skillUpdateFromTool(prisma as never, owner, {
      skillId,
      name: "Should not apply",
      description: "still original name",
    });
    expect(mistyped).toMatchObject({ ok: true, name: "Original" });

    const renamed = await skillUpdateFromTool(prisma as never, owner, {
      skillId,
      newName: "Renamed",
    });
    expect(renamed).toMatchObject({ ok: true, name: "Renamed" });
  });

  it("scopes list to the owner workspace and injects catalog lines", async () => {
    prisma = makePrisma([
      {
        id: "other-1",
        spaceId: "ws-2",
        userId: "user-2",
        name: "Other workspace skill",
        description: "not visible",
        content: buildSkillMd({
          name: "Other workspace skill",
          description: "not visible",
          body: "x",
        }),
        source: "user",
      },
    ]);
    await skillCreateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "steps",
    });
    const records = await listAgentSkillRecords(prisma as never, owner);
    expect(records.map((row) => row.name)).toContain("Daily standup");
    expect(records.map((row) => row.name)).not.toContain("Other workspace skill");
    const catalog = formatSkillsCatalogInstruction(records);
    expect(catalog).toContain("- Daily standup: Prepare standup notes");
    expect(catalog).toContain("skill_read");
  });

  it("rejects update/delete for plugin and builtin skills", async () => {
    prisma = makePrisma([
      {
        id: "plugin-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Plugin recipe",
        description: "From a plugin",
        content: buildSkillMd({
          name: "Plugin recipe",
          description: "From a plugin",
          body: "do not edit",
        }),
        source: "plugin",
      },
    ]);
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Plugin recipe",
        description: "hijack",
      }),
    ).toEqual({ error: "Builtin and plugin skills are read-only." });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Plugin recipe" })).toEqual({
      error: "Builtin and plugin skills are read-only.",
    });
  });

  it("ships builtin skills as valid, readable, read-only SKILL.md records", async () => {
    expect(BUILTIN_AGENT_SKILLS.map((skill) => skill.name)).toContain("Interrogate");
    for (const skill of BUILTIN_AGENT_SKILLS) {
      const parsed = parseSkillMd(skill.content);
      expect(parsed).toMatchObject({ name: skill.name, description: skill.description });
      // / picker truncates at 72; keep descriptions short so "review only" stays visible.
      expect(skill.description.length).toBeLessThanOrEqual(72);
    }

    const records = await listAgentSkillRecords(prisma as never, owner);
    const interrogate = records.find((row) => row.name === "Interrogate");
    expect(interrogate).toMatchObject({
      id: "builtin:Interrogate",
      source: "builtin",
      readOnly: true,
    });
    expect(formatSkillsCatalogInstruction(records)).toContain("- Interrogate:");
    expect(formatSkillsCatalogInstruction(records)).toContain("Review only");

    const read = await skillReadFromTool(prisma as never, owner, { name: "interrogate" });
    expect(read).toMatchObject({ name: "Interrogate", source: "builtin", readOnly: true });
    expect(String(read.content)).toContain("Do not modify files");

    expect(
      await skillCreateFromTool(prisma as never, owner, {
        name: "interrogate",
        description: "shadow the builtin",
        body: "steps",
      }),
    ).toEqual({ error: 'A skill named "Interrogate" already exists.' });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Interrogate",
        description: "hijack",
      }),
    ).toEqual({ error: "Builtin and plugin skills are read-only." });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Interrogate" })).toEqual({
      error: "Builtin and plugin skills are read-only.",
    });
  });

  it.each(["interrogate", " Interrogate "])("preserves a saved skill named %j", async (name) => {
    prisma = makePrisma([
      {
        id: "legacy-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name,
        description: "my review recipe",
        content: buildSkillMd({
          name,
          description: "my review recipe",
          body: "my steps",
        }),
        source: "user",
      },
    ]);

    const records = await listAgentSkillRecords(prisma as never, owner);
    expect(records.filter((skill) => skill.name.trim().toLowerCase() === "interrogate")).toEqual([
      expect.objectContaining({ id: "legacy-1", source: "user", readOnly: false }),
    ]);
    expect(await skillReadFromTool(prisma as never, owner, { name: "Interrogate" })).toMatchObject({
      name,
      source: "user",
      readOnly: false,
    });
    expect(await skillReadFromTool(prisma as never, owner, { skillId: "legacy-1" })).toMatchObject({
      name,
      source: "user",
    });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Interrogate",
        description: "still mine",
      }),
    ).toMatchObject({ ok: true });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Interrogate" })).toEqual({
      ok: true,
      name: name.trim(),
    });
  });

  it("rejects oversized skill content", async () => {
    const body = "x".repeat(100_001);
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Huge",
      description: "too big",
      body,
    });
    expect(created).toMatchObject({ error: expect.stringContaining("at most") });
  });

  it("rejects overlong skill names on structured create and rename", async () => {
    const longName = "N".repeat(81);
    expect(
      await skillCreateFromTool(prisma as never, owner, {
        name: longName,
        description: "ok description",
        body: "steps",
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });

    await skillCreateFromTool(prisma as never, owner, {
      name: "Short",
      description: "ok description",
      body: "steps",
    });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Short",
        newName: longName,
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });
  });
});

describe("bot-scoped skills", () => {
  const botOwner = { spaceId: "ws-1", userId: "user-1", botId: "bot-1" };
  const otherBot = { spaceId: "ws-1", userId: "user-1", botId: "bot-2" };

  function spaceSkill(id: string, name: string, allBots: boolean, assigned: string[] = []) {
    return {
      id,
      spaceId: "ws-1",
      userId: "user-1",
      botId: null,
      name,
      description: `desc ${name}`,
      content: buildSkillMd({ name, description: `desc ${name}`, body: "space" }),
      source: "user",
      allBots,
      assignments: assigned.map((botId) => ({ botId })),
    };
  }

  function botSkill(id: string, name: string, botId: string) {
    return {
      id,
      spaceId: "ws-1",
      userId: "user-1",
      botId,
      name,
      description: `desc ${name}`,
      content: buildSkillMd({ name, description: `desc ${name}`, body: botId }),
      source: "user",
      allBots: true,
      assignments: [],
    };
  }

  it("shows a bot its own skills and granted space skills only", async () => {
    const prisma = makePrisma([
      spaceSkill("s-all", "For everyone", true),
      spaceSkill("s-picked", "For picked bots", false, ["bot-1"]),
      spaceSkill("s-other", "For the other bot", false, ["bot-2"]),
      spaceSkill("s-none", "For no bot", false),
      botSkill("b-mine", "Mine alone", "bot-1"),
      botSkill("b-theirs", "Theirs alone", "bot-2"),
    ]);
    const names = (await listAgentSkillRecords(prisma as never, botOwner)).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining(["For everyone", "For picked bots", "Mine alone"]),
    );
    expect(names).not.toContain("For the other bot");
    expect(names).not.toContain("For no bot");
    expect(names).not.toContain("Theirs alone");
  });

  it("lets a bot's own skill shadow a same-named space skill", async () => {
    const prisma = makePrisma([
      spaceSkill("s-export", "export-report", true),
      botSkill("b-export", "export-report", "bot-1"),
    ]);
    const records = await listAgentSkillRecords(prisma as never, botOwner);
    const exports = records.filter((row) => row.name === "export-report");
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ id: "b-export", botId: "bot-1" });
    // Another bot still sees the space skill, not the shadowing one.
    const others = await listAgentSkillRecords(prisma as never, otherBot);
    expect(others.find((row) => row.name === "export-report")).toMatchObject({ id: "s-export" });
  });

  it("saves a bot's new skill as its own, invisible to other bots", async () => {
    const prisma = makePrisma([]);
    const created = await skillCreateFromTool(prisma as never, botOwner, {
      name: "Learned trick",
      description: "Picked up during a run",
    });
    expect(created).toMatchObject({ ok: true });
    const row = prisma._store.find((item) => item.name === "Learned trick");
    expect(row).toMatchObject({ botId: "bot-1" });
    expect(await listAgentSkillRecords(prisma as never, otherBot)).not.toContainEqual(
      expect.objectContaining({ name: "Learned trick" }),
    );
  });

  it("lets a bot change only its own skills, never the space's", async () => {
    const prisma = makePrisma([
      spaceSkill("s-all", "Shared", true),
      botSkill("b-mine", "Mine", "bot-1"),
    ]);
    expect(
      await skillUpdateFromTool(prisma as never, botOwner, {
        name: "Shared",
        description: "hijack",
      }),
    ).toMatchObject({ error: expect.stringContaining("Only the user can change a space skill") });
    expect(await skillDeleteFromTool(prisma as never, botOwner, { name: "Shared" })).toMatchObject({
      error: expect.stringContaining("Only the user can change a space skill"),
    });
    expect(
      await skillUpdateFromTool(prisma as never, botOwner, {
        name: "Mine",
        description: "own edit",
      }),
    ).toMatchObject({ ok: true });
  });

  it("keeps the user's own context able to change space skills", async () => {
    const prisma = makePrisma([spaceSkill("s-all", "Shared", true)]);
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Shared",
        description: "user edit",
      }),
    ).toMatchObject({ ok: true });
  });
});
