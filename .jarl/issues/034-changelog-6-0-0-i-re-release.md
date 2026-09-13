# 034 · changelog 6 0 0 i re release

**Status:** done
**Kind:** process
**Priority:** 3
**Tier:** standard
**Tags:** proces
**Files:** CHANGELOG.md, .github/workflows/release.yml
**Found by:** jarl, reading every file of Horde
**Where:** CHANGELOG.md; GitHub Releases

## What
Każdy wpis z tej pracy idzie pod `[6.0.0]`, nie pod Unreleased. Przed ponownym wydaniem: skasować tag v6.0.0 i release na GitHubie, ustawić datę sekcji na dzień ponownego wydania, push main; workflow tworzy tag i release na nowo.

## Why
Decyzja klienta: ma być jedno wydanie 6.0.0.

## Acceptance
Sekcja 6.0.0 czyta się jak jedno wydanie; jedna data; jeden tag; jeden release.

Dowód, którego oczekuję: GitHub Releases pokazuje jedno 6.0.0.

Uwagi: Skasowanie tagu i release na słowo klienta, na końcu.

## Evidence

- **ran:** cat CHANGELOG.md (one [6.0.0] header, confirmed); read .github/workflows/release.yml in full; list_releases/list_tags on krzysztofdudek/Horde · **saw:** exactly one v6.0.0 tag and release exist; workflow's re-release runbook already correct; no code defect found — the only remaining step (delete+recreate the tag/release) is gated on the maintainer's word at the end of this whole batch, per decisions.md's jedno-wydanie-6-0-0 ruling, and not a worker's to do

