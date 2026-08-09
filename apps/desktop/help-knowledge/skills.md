---
id: skills
title: Skills (reusable agent capabilities)
summary: Browse, install, publish, and update agent skills while keeping each agent's native skills isolated.
---
Skills are reusable agent capabilities you package as a folder and load into your sessions. They're managed on the same page as Plugins — **Skills** and **Plugins** are two tabs of one management surface (the Skills tab is the in-app browser for finding, installing, publishing, and updating skills).

**Skills stay scoped to the right agent:**

- Each agent keeps its official and built-in skills in its own native directory, so agent updates can add or replace them without affecting another harness.
- A small number of custom skills can be shared across agents explicitly. Cindy links each selected skill individually; it never imports another agent's entire skills directory.

**Where skills live on disk:**

- Cindy-managed global custom skills live under `~/.agents/skills/<name>/`. Claude Code and Codex keep their native skills under `~/.claude/skills/` and `~/.codex/skills/` respectively. On Windows these directories are under `C:\Users\<you>\`.
- Optional cross-agent bridges are declared in `~/.config/cindy/skill-bridges.json`. Only the named skill is linked to the named target; with no config, Cindy creates no cross-agent links and leaves user-owned links untouched.
- Project-scoped (only inside one working directory): `<working-dir>/.agents/skills/<name>/` or `<working-dir>/.claude/skills/<name>/`.
- Each skill is its own folder with a required `SKILL.md` at the root (the prompt / spec the agent reads). Sibling files and subfolders in that folder are also visible to the agent.

**Sharing selected global skills:**

```json
{
  "version": 1,
  "bridges": [
    {
      "source": "agents",
      "skill": "search-verify",
      "targets": ["claude", "codex", "cindy"]
    }
  ]
}
```

- `source` can be `agents`, `claude`, or `codex`; the source folder remains the single copy that owns the skill.
- `targets` can contain `agents`, `claude`, `codex`, or `cindy`. Cindy-managed plugin skills are connected to Cindy automatically and do not need bridge entries.

**Importing a local skill:**

- On the Skills page, use **Import skill** (top-right) to pick a `.zip` package or a standalone `SKILL.md` file.
- A zip must contain a `SKILL.md` (at the package root, or inside a single top-level folder). The YAML frontmatter must include non-empty `name` and `description` fields; `name` must match `^[a-z0-9-]{1,200}$`.
- You then choose where to install: global, a known project, or another directory. Cindy extracts metadata from the file automatically and lists the skill with that name and description.
- Imported skills can be uninstalled from the detail page, and you can publish them to SkillHub later if you want.

**Using an installed skill:**

- Type `/` in the composer to open the slash-command palette; skills available to the current agent show up alongside built-in and agent commands. Pick one to run it.

**Publishing your own skill:**

- Find the publish action on the Skills page and point it at the skill's local folder. It zips the folder and uploads it — reading your directory in place, without copying or moving anything.
- On first publish, you set the skill's **visibility**: PUBLIC (anyone in the org) or DEPARTMENT_SCOPED (only the departments you choose).
- The local registry records what you published, so the app knows it's "yours" for future updates.

**Updating an already-published skill:**

- On your own skill's detail page you'll see a **发布新版本** (Publish New Version) button.
- Edit the local folder however you want and publish — the version is **auto-incremented server-side**, you don't pick a number.
- **Old versions stay live alongside the new one.** Users who already installed an older version keep it until they choose to update.
- The display name and description are sent on every republish, so editing those metadata fields just means doing a republish.

**Managing an already-published skill:**

- Change who can see or use your skill from the management menu — public, shared with selected teams / departments, or private to you.
- **Unpublish** makes it private again and returns ownership to your personal scope; it does not remove copies other users already installed.
- **Authorship is fixed.** Only the original author's account can publish new versions of a given skill (enforced server-side as `NOT_AUTHOR`).

**Browsing and installing others' skills:**

- The marketplace lets you install skills into your global skills directory. You can request a specific version on install; the local registry tracks which version you have.

**Notes:**

- A skill folder without a `SKILL.md` at its root won't be picked up (lowercase `skill.md` is also accepted).
- Project-scoped skills only show up in sessions whose working directory matches — useful for skills tied to a particular repo's conventions.
- Editing files inside an installed skill folder takes effect on the next session start; you don't need to reinstall.
- Uninstalling only removes your local copy. For your own published skills, use unpublish or manage visibility to change market availability.
