# 012 · reset trunku po cichu

**Status:** done
**Kind:** bug
**Priority:** 2
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/_lib.mjs, reference/model.md, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/_lib.mjs resolveTree (gałąź --horde)

## What
Worktree trunku jest resetowany `git reset --hard` przy każdym odczycie. Ręczna zmiana w tym drzewie znika bez słowa.

## Why
Zasada „trunk pisze tylko skrypt lądowania” jest słuszna, ale ciche kasowanie pracy człowieka nie.

## Acceptance
Gdy reset odrzuca zmiany, jedna linia na stderr mówi, ile plików odrzucono i dlaczego. Zdanie o tym w model.md i README skryptów. Test z brudnym drzewem trunku.

Dowód, którego oczekuję: skills/horde/scripts/tests/lib.test.mjs.

## Evidence

- **ran:** node --test tests/lib.test.mjs · **saw:** 29/29 pass; merged; README.md conflict with 003's rewrite resolved by inserting the new sentence into HEAD's current paragraph structure

