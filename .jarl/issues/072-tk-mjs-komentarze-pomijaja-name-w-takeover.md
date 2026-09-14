# 072 · tk mjs komentarze pomijaja name w takeover

**Status:** done
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tk.mjs
**Found by:** worker 044
**Where:** skills/horde/scripts/tk.mjs:99, :208 — komentarze wzorcowe `brief.mjs worker NNN --takeover`

## What
Te same dwa miejsca w komentarzach `tk.mjs` pokazują wywołanie `brief.mjs worker NNN --takeover` bez wymaganego `--name <n>`, tak samo jak przykłady naprawione w issue 044 (README.md, SKILL.md).

## Why
Skopiowany komentarz kończy się tą samą odmową co przykłady z 044.

## Acceptance
Oba komentarze w tk.mjs niosą `--name <n>`. Test docs (016 albo skaner z 044) obejmuje też komentarze w tk.mjs, nie tylko README/SKILL.

## Evidence

- **ran:** node --test skills/horde/scripts/tests/docs.test.mjs · **saw:** 34/34 pass; confirmed red-before by temporarily reverting the tk.mjs comment fix (scanner test failed), green-after restoring it

