# Horde

## Purpose

This repository exists solely so the author can develop and version the horde skill. The canonical file is `skills/horde/SKILL.md`, together with everything it points at under `skills/horde/reference/`, `skills/horde/templates/` and `skills/horde/scripts/` — people install it as a Claude Code plugin (or copy that whole directory into their agent's skill dir). Nothing in this repo (CLAUDE.md, CHANGELOG.md, README.md, CI, etc.) may affect the skill's mechanics. All behavior must be self-contained in `skills/horde/`.

Horde is part of the Yggdrasil family of AI-coding-agent correctness tools. The other three — Ratatoskr (request → intent), Urd (intent → code), Yggdrasil (code → architecture) — are disciplines a single agent follows. Horde is what you reach for when the mission does not fit in one agent's context: it turns the agent into a director that raises a steward, owners, an architect, workers and verifiers, and holds all of them to the same standards the rest of the family enforces — evidence over reports, ask rather than guess, plain language back to the user, architecture checked before it lands. Depth follows the graph; the same skill runs one level down (director : mission :: owner : node).

This repo never names or links Vision (the author's private practice hub) or the client repository the skill was originally built in. Its origin and development context stay private; only the finished skill ships here.

## Plugin scaffolding

This repo is installable as a Claude Code plugin, a GitHub Copilot CLI plugin, an OpenAI Codex CLI plugin and a Cursor plugin. Layout mirrors the convention used by sibling repos (UrdSkill, RatatoskrSkill, ResearcherSkill):
- `.claude-plugin/plugin.json` — plugin manifest (name, version, description, keywords). `version` here MUST match the latest released version in `CHANGELOG.md` and is bumped together with it.
- `.claude-plugin/marketplace.json` — single-plugin marketplace listing for Claude Code, so the repo can be added via `/plugin install horde@horde-marketplace`.
- `.github/plugin/marketplace.json` — single-plugin marketplace listing for GitHub Copilot CLI (Copilot reads this path), so the repo can be added via `copilot plugin marketplace add krzysztofdudek/Horde` then `copilot plugin install horde@horde-marketplace`. Mirrors the Claude listing but additionally carries `version` and a `skills` array (`./skills/horde`). Its plugin `version` MUST be kept in lockstep with `plugin.json`.
- `.codex-plugin/plugin.json` — plugin manifest for OpenAI Codex CLI (Codex reads the plugin manifest only from `.codex-plugin/`). Bundles the skill via `"skills": "./skills/"`; Codex discovers the marketplace from the existing `.claude-plugin/marketplace.json` (its legacy-compatible path), so the repo installs via `codex plugin marketplace add krzysztofdudek/Horde` then `codex plugin install horde@horde-marketplace`. Its `version` MUST be kept in lockstep with `plugin.json`.
- `.cursor-plugin/plugin.json` — plugin manifest for Cursor (single-plugin-at-root: manifest at the repo root, no Cursor marketplace file; components are auto-discovered, so `skills/horde/` is picked up automatically). Installed locally via `~/.cursor/plugins/local/` or published to the Cursor Marketplace. Its `version` MUST be kept in lockstep with `plugin.json`.
- `skills/horde/` — the canonical skill body: `SKILL.md`, `reference/` (mental model, topology, one brief per role), `templates/` (charter, ticket, verdict, wave close) and `scripts/` (the Node tool set the skill's one rule requires — all state mutates only through these). Editing this directory IS editing the skill.

No `hooks/` directory: unlike Ratatoskr, horde does not need forced every-turn activation — it is invoked explicitly (`/horde <mission>`) or resumed at the start of a session that already has one running, exactly as its `SKILL.md` description says, and that is enough for it to trigger on its own.

**Script paths inside the skill body** (`SKILL.md`, `reference/roles/*.md`) are written as `${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/…` rather than a bare relative path. Claude Code and Codex CLI set `CLAUDE_PLUGIN_ROOT` for an installed plugin, so a marketplace install resolves correctly wherever the plugin cache actually lives; the `:-.claude/skills/horde` fallback keeps the older manual drop-in (copying `skills/horde/` straight into a target repo's `.claude/skills/horde/`) working unchanged for whoever still does that. This assumes subagents the skill spawns inherit the same environment variable as the director's own session — unverified against a real multi-agent run; if a spawned steward or owner can't find its scripts, that assumption is the first thing to check.

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
