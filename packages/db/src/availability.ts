/**
 * Skills, MCP servers and plugin or tool-source installs belong to the account that added them.
 * Each is available in the space it was added in (`spaceId`), in every space of its owner
 * (`allSpaces`, which includes spaces created later), or also in chosen further spaces
 * (`availableIn`). Nobody but the owner ever sees them.
 */
export function availableInSpace(scope: { spaceId: string; userId: string }) {
  return {
    userId: scope.userId,
    OR: [
      { spaceId: scope.spaceId },
      { allSpaces: true },
      { availableIn: { some: { spaceId: scope.spaceId } } },
    ],
  };
}

/** An item's secret is this space's or, once the item reaches further spaces, the account's. */
export function itemSecretIn(scope: { spaceId: string; userId: string }) {
  return { userId: scope.userId, OR: [{ spaceId: scope.spaceId }, { spaceId: null }] };
}

/**
 * The agent skills one bot can use: its own skills (botId set to it) plus space skills
 * visible in the space that are for every bot (allBots) or assigned to it. Callers dedupe
 * by name with the bot's own skill winning, so a bot can shadow a space skill's name
 * without other bots ever seeing the shadowing content.
 */
export function botVisibleSkillsWhere(scope: { spaceId: string; userId: string }, botId: string) {
  return {
    AND: [
      availableInSpace(scope),
      {
        OR: [
          { botId },
          { botId: null, allBots: true },
          { botId: null, assignments: { some: { botId } } },
        ],
      },
    ],
  };
}

/** Select alongside a row so `spaceAvailability` can describe it. */
export const AVAILABILITY_SELECT = { select: { spaceId: true } } as const;

export type SpaceAvailability = { allSpaces: boolean; spaceIds: string[] };

/** The spaces an item is available in, starting with the one it was added in. */
export function spaceAvailability(row: {
  spaceId: string;
  allSpaces: boolean;
  availableIn?: Array<{ spaceId: string }>;
}): SpaceAvailability {
  return {
    allSpaces: row.allSpaces,
    spaceIds: [
      row.spaceId,
      ...(row.availableIn ?? []).map((entry) => entry.spaceId).filter((id) => id !== row.spaceId),
    ],
  };
}
