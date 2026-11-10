# Skills

A skill is written know-how a bot follows for a specific task, such as how you want expenses filed
or how to publish a blog post.

## Use a skill

Bots pick up the right skill on their own when a task matches it. To use one explicitly, type **/**
at the start of a message and choose it.

## Your skills library

Open the account menu (your avatar at the bottom of the sidebar) and choose **Skills**.

- **Your skills** lists skills you or your bots have saved.
- **Plugins** lists skill sets you've added from plugins.
- **Browse** finds ready-made skills. Open one and choose **Add skills**.

Skills you add are available to all your bots. Choose **New skill** to write one yourself: a name,
a short description of when to use it, and the steps.

You can also add skills from a GitHub repository: choose **From GitHub**, paste the repository URL,
then **Preview** and **Add**.

> [!NOTE]
> Skills added from GitHub or a plugin are instructions only. Any scripts they include are not run.

## Space skills and a bot's own

A skill belongs to the space or to one bot.

- **Space skills** (what you add yourself) are shared: every bot in the space can use them. Open a
  skill and choose the bots next to it to narrow it to some of them, and **To bot** to hand the
  skill to one bot alone.
- **A bot's own skills** belong to that bot only. No other bot sees them, even in the same space.
  In the bot's settings under **Skills** you can write one for it, choose which space skills it may
  use, and **Share with space** to turn one of its own into a shared skill.

A bot's own skill with the same name as a space skill replaces that skill for the bot alone; the
space skill keeps working for every other bot. Bots cannot change space skills — only you can.

## Bots save skills too

After a multi-step task, ask the bot to "save that as a skill". It writes the skill as its own so
it can repeat the task next time; your other bots are unaffected until you share it. A skill a bot
saves stays in the [space](./spaces.md) it was made in.

## Teach a task by showing it

Some tasks are easier to show than describe.

1. Open the bot's computer with **Agent computer**.
2. Choose **Teach a task** and describe the result you will demonstrate, such as "Export this week's
   list from the CRM and drop it in the shared folder".
3. Choose **Start recording** and do the task on the bot's screen. The bot watches but does not act.
   Type passwords with **Protected input** so they are not recorded.
4. Choose **Stop teaching**.

The bot posts a **Draft skill** card with the steps it learned, when to use them, what to check, and
when to ask you first. Edit anything that's off, then choose **Save**. **Test** runs it once, and
**Add to routine** puts it on a schedule.

Teach a task is available on the web and desktop apps, not on mobile.
