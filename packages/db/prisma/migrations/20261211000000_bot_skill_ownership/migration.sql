-- Bot-owned skills and per-bot visibility of space skills.
-- Additive: null botId keeps every existing skill a space skill, and allBots = true
-- keeps it visible to every bot, so the previous release's code behaves identically.
ALTER TABLE "agent_skills" ADD COLUMN "botId" TEXT;
ALTER TABLE "agent_skills" ADD COLUMN "allBots" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "agent_skills_botId_idx" ON "agent_skills"("botId");

-- One bot's grant of one space skill, mirroring bot_mcp_servers.
CREATE TABLE "agent_skill_bots" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_skill_bots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_skill_bots_skillId_botId_key" ON "agent_skill_bots"("skillId", "botId");
CREATE INDEX "agent_skill_bots_spaceId_userId_botId_idx" ON "agent_skill_bots"("spaceId", "userId", "botId");

ALTER TABLE "agent_skill_bots"
  ADD CONSTRAINT "agent_skill_bots_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_skill_bots_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "agent_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_skill_bots_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A name is unique per owner dimension: among space skills (botId null) and separately
-- among one bot's own skills, so a bot can shadow a space skill's name on purpose.
-- COALESCE keeps rows from the previous release (botId null) under the old uniqueness.
DROP INDEX IF EXISTS "agent_skills_spaceId_userId_name_lower_key";
CREATE UNIQUE INDEX "agent_skills_spaceId_userId_name_lower_key"
  ON "agent_skills"("spaceId", "userId", (COALESCE("botId", '')), (lower("name")));
