# 038 · tk usage nie wymienia komendy move

**Status:** done
**Kind:** docs
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tk.mjs
**Found by:** reader A, reading tk.mjs
**Where:** skills/horde/scripts/tk.mjs:65–119 USAGE wobec :710–721 cmdMove i dispatch :850–859

## What
`move NNN --team t` działa i jest w README skryptów, ale nie ma go w USAGE tk.mjs.

## Why
`--help` nie mówi o komendzie, która istnieje.

## Acceptance
USAGE wymienia move z tą samą składnią co README; test docs (issue 016) łapie tę klasę.

## Evidence

- **ran:** node tk.mjs --help 2>&1 | grep -A2 'move <ticket>' · **saw:** move <ticket> --team <t> [--horde h] now documented in tk.mjs's own USAGE template, with its relocate/refuse-duplicate behaviour described

