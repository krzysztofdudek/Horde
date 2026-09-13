# 063 · changelog claims a strict yggdrasil major version pin that

**Status:** open
**Kind:** docs
**Priority:** 3
**Model:** sonnet
**Tags:** proces
**Files:** CHANGELOG.md
**Found by:** workflow finder changelog-vs-code, confirmed by two refuters
**Where:** CHANGELOG.md:12

## What
CHANGELOG claims a strict Yggdrasil major-version pin that the code explicitly does not implement

The [6.0.0] section header reads: "Needs Yggdrasil 6.x — the same major, refused otherwise." This describes a check that accepts only a 6.x release of Yggdrasil and refuses a 7.x (or any other major). The actual gate in skills/horde/scripts/node.mjs is a floor check keyed on document *schema name*, not on comparing version numbers at all: `YG_DOCUMENTS_AFTER = '6.0.0'` (node.mjs:160) is preceded by the comment "The release line these machine documents arrived in. Checked by schema name, never by comparing version numbers" (node.mjs:154-155), and the actual test is `parsed.schema === schema` (node.mjs:298) inside `ygJson`. A hypothetical Yggdrasil 7.x that still answers with `yg-node/1`/`yg-context/1`/`yg-impact/1` would pass this check, contradicting "refused otherwise." README.md's own Requirements section (line 27) correctly states the floor as "Yggdrasil 6.0.0 or newer" with no major-version ceiling, which is inconsistent with the changelog's "same major, refused otherwise" framing right next to it.

## Why
This is a factual claim about compatibility (what versions of Yggdrasil will or won't work) directly contradicted by the code's own explanatory comment, and it also contradicts the adjacent README wording ("6.0.0 or newer", no ceiling) — an adopter reading the changelog would wrongly conclude a Yggdrasil 7.0.0 is refused by design.

## Acceptance
The changelog should describe the actual mechanism (a floor keyed on the versioned documents' schema, forward-compatible with any release that still answers those documents) rather than claiming a same-major-only gate that would refuse a newer major release.

Dowód, którego oczekuję: Read skills/horde/scripts/node.mjs:150-160 and :273-299 — the comment and the `parsed.schema === schema` equality test show the check never compares semver majors; there is no code path anywhere in node.mjs that reads or rejects based on a major-version number.

Refuterzy: Confirmed as stated. CHANGELOG.md:12 says "Needs Yggdrasil 6.x — the same major, refused otherwise," but skills/horde/scripts/node.mjs:154-155 explicitly states the check is "by schema name, never by  | Verified both sides. CHANGELOG.md:12 says \"Needs Yggdrasil 6.x — the same major, refused otherwise,\" implying a major-version ceiling that refuses 7.x. But node.mjs:154-155 explicitly states the che

## Evidence

