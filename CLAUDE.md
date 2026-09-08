# Horde

## Purpose

This repository exists solely so the author can develop and version the horde skill. The canonical file is `skills/horde/SKILL.md`, together with everything it points at under `skills/horde/reference/`, `skills/horde/templates/` and `skills/horde/scripts/` — people install it as a Claude Code plugin (or copy that whole directory into their agent's skill dir). Nothing in this repo (CLAUDE.md, CHANGELOG.md, README.md, CI, etc.) may affect the skill's mechanics. All behavior must be self-contained in `skills/horde/`.

Horde is the third layer of the Yggdrasil family. Yggdrasil holds the architecture graph and the rails; Grain mines the first graph for a repository that has none; Horde works that graph when the mission does not fit in one agent's context, turning the agent into a director that raises a steward, owners, an architect, workers and verifiers and holding all of them to the same rules — evidence over reports, ask rather than guess, plain language back to the user, architecture checked before it lands. Adoption goes bottom-up: Yggdrasil first, Grain when there is no graph yet, Horde when one agent is no longer enough. The three add-ons — Ratatoskr, Urd, Researcher — attach to the agent, not to the graph. Depth follows the graph; the same skill runs one level down (director : mission :: owner : node).

This repo never names or links Vision (the author's private practice hub) or the client repository the skill was originally built in. Its origin and development context stay private; only the finished skill ships here.

## Requirements

The skill's mechanics depend on Claude Code's [Agent Teams](https://code.claude.com/docs/en/agent-teams) (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, off by default, experimental, interactive sessions only). README's `## Requirements` section carries the user-facing setup step; this note is the engineering pointer behind it. Confirmed working end to end by Krzysztof on a real mission, steward spawning its own owners and workers included. Also verified there, and the constraint the skill's topology now rests on: a teammate can spawn subagents (and subagents can spawn their own) but never another teammate — teammates are created by the top-level session alone, and a subagent is resumable by its parent and by nobody else.

This repo is installable as a Claude Code plugin, a GitHub Copilot CLI plugin, an OpenAI Codex CLI plugin and a Cursor plugin. Layout mirrors the convention used by sibling repos (UrdSkill, RatatoskrSkill, ResearcherSkill):
- `.claude-plugin/plugin.json` — plugin manifest (name, version, description, keywords). `version` here MUST match the latest released version in `CHANGELOG.md` and is bumped together with it.
- `.claude-plugin/marketplace.json` — single-plugin marketplace listing for Claude Code, so the repo can be added via `/plugin install horde@horde-marketplace`.
- `.github/plugin/marketplace.json` — single-plugin marketplace listing for GitHub Copilot CLI (Copilot reads this path), so the repo can be added via `copilot plugin marketplace add krzysztofdudek/Horde` then `copilot plugin install horde@horde-marketplace`. Mirrors the Claude listing but additionally carries `version` and a `skills` array (`./skills/horde`). Its plugin `version` MUST be kept in lockstep with `plugin.json`.
- `.codex-plugin/plugin.json` — plugin manifest for OpenAI Codex CLI (Codex reads the plugin manifest only from `.codex-plugin/`). Bundles the skill via `"skills": "./skills/"`; Codex discovers the marketplace from the existing `.claude-plugin/marketplace.json` (its legacy-compatible path), so the repo installs via `codex plugin marketplace add krzysztofdudek/Horde` then `codex plugin install horde@horde-marketplace`. Its `version` MUST be kept in lockstep with `plugin.json`.
- `.cursor-plugin/plugin.json` — plugin manifest for Cursor (single-plugin-at-root: manifest at the repo root, no Cursor marketplace file; components are auto-discovered, so `skills/horde/` is picked up automatically). Installed locally via `~/.cursor/plugins/local/` or published to the Cursor Marketplace. Its `version` MUST be kept in lockstep with `plugin.json`.
- `skills/horde/` — the canonical skill body: `SKILL.md`, `reference/` (mental model, topology, one brief per role), `templates/` (charter, ticket, verdict, wave close) and `scripts/` (the Node tool set the skill's one rule requires — all state mutates only through these). Editing this directory IS editing the skill.

No `hooks/` directory: unlike Ratatoskr, horde does not need forced every-turn activation — it is invoked explicitly (`/horde <mission>`) or resumed at the start of a session that already has one running, exactly as its `SKILL.md` description says, and that is enough for it to trigger on its own.

**Script paths inside the skill body** (`SKILL.md`, `reference/roles/*.md`) are written as `${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/…` rather than a bare relative path. Claude Code and Codex CLI set `CLAUDE_PLUGIN_ROOT` for an installed plugin, so a marketplace install resolves correctly wherever the plugin cache actually lives; the `:-.claude/skills/horde` fallback keeps the older manual drop-in (copying `skills/horde/` straight into a target repo's `.claude/skills/horde/`) working unchanged for whoever still does that. Observed on a real mission: a subagent is not guaranteed to receive `CLAUDE_PLUGIN_ROOT`, and in a repository that installed the plugin the `.claude/skills/horde` fallback does not exist, so a brief handed to a subagent carries the absolute plugin path explicitly (`export CLAUDE_PLUGIN_ROOT=…` at the top of the brief) rather than relying on inheritance.

When bumping version, update the `version` in all of `.claude-plugin/plugin.json`, `.github/plugin/marketplace.json` (plugin entry), `.codex-plugin/plugin.json`, and `.cursor-plugin/plugin.json` in lockstep with the CHANGELOG section header.

## Versioning

This project uses [Semantic Versioning](https://semver.org/) and maintains a [CHANGELOG.md](CHANGELOG.md) following the [Keep a Changelog](https://keepachangelog.com/) format.

When the user says "bump version":
1. Move `[Unreleased]` entries in `CHANGELOG.md` into a new version section with today's date
2. Update the comparison links at the bottom of `CHANGELOG.md` (add the new `[X.Y.Z]: …compare/vA.B.C...vX.Y.Z` line and point `[Unreleased]` at the new version)
3. Update the `version` in `.claude-plugin/plugin.json`, `.github/plugin/marketplace.json` (plugin entry), `.codex-plugin/plugin.json`, and `.cursor-plugin/plugin.json` to match
4. Commit the bump and push to `main` — that's it.

Do not create or push tags manually. The `.github/workflows/release.yml` workflow runs on every push to `main`, reads the top version from `CHANGELOG.md`, and if `v<version>` does not already exist it creates the tag, pushes it, and publishes a GitHub Release with notes extracted from the matching changelog section.

### Changelog register

`CHANGELOG.md` is written for the adopter, not the developer. Plain language, zero jargon, zero narration, facts only — no file names, no internal mechanics, no reasoning about why a change was made. State only what changed, the way someone deciding whether to install this would want to read it. Every entry gets the plain-language discipline from Ratatoskr, Krzysztof's own voice, and the stop-slop pass before it ships.
