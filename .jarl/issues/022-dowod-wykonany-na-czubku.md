# 022 · dowod wykonany na czubku

**Status:** in-progress
**Kind:** gap
**Priority:** 1
**Tier:** strong
**Tags:** kontrakt
**Files:** skills/horde/scripts/land.mjs, skills/horde/scripts/horde.mjs, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/land.mjs (po punkcie gate); config.gates.report {path, format}

## What
Lądowanie czyta raport runnera z przebiegu bramki na sha czubka i wymaga, żeby sparowany przypadek każdej żywej obietnicy był w raporcie i przeszedł.

## Why
Obecność pliku testowego nie jest dowodem wykonania. Pominięty test przechodzi dziś każdą regułę i bramkę.

## Acceptance
Formaty: junit (xml), playwright-json, tap. Brak przypadku w raporcie albo status skipped/failed → odmowa z nazwą obietnicy. Brak skonfigurowanego raportu → punkt mówi „no report configured”, nie udaje zieleni. Test na fixture z raportem JUnit.

Dowód, którego oczekuję: skills/horde/scripts/tests/land.test.mjs.

Uwagi: Środowisko i runner są poza Hordą; Horda tylko czyta raport, który bramka zostawiła.

## Evidence

- **ran:** cd skills/horde/scripts && HORDE_TEST_YG="node .../bin.js" timeout 3000 node --test tests/land.test.mjs (final, on the tip) · **saw:** # tests 114 / # pass 114 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0 (was 95/95/0 before this ticket; 19 new cases — 14 end to end through land.mjs, 5 pinning the parsers and the two matching rules)
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG=... timeout 2400 node --test tests/law-guard.test.mjs · **saw:** # tests 51 / # pass 51 / # fail 0 / # skipped 0 — unchanged from 021, so the shared promise reading gained a field and broke none of its guards
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG=... timeout 900 node --test tests/docs.test.mjs (after the README/SKILL/model edits) · **saw:** # tests 35 / # pass 35 / # fail 0 / # skipped 0 — the item-list-vs-CHECK_ORDER check and the doc-vs-USAGE scan both still hold
- **ran:** the acceptance case the issue names: a fixture whose gate command writes a real JUnit report, with a live promise mirrored by promises/adds-two-numbers.test.mjs · **saw:** green — "reports/junit.xml (junit) — all 1 live promise(s) ran and passed in it (2 case(s) read)", and the branch merged
- **ran:** the three refusals the acceptance asks for, each on its own fixture: the case absent from the report; the case present and skipped; the case present and failed · **saw:** each red with the promise named — "adds-two-numbers: nothing in the report is attributed to promises/adds-two-numbers.test.mjs"; "... with \"adds two numbers\" skipped, not passed"; "... failed, not passed" — and nothing merged in any of them
- **ran:** the "no report configured" case: the same live promise in the tree, gates.report unset · **saw:** green, landed, and the item reads "green (true) — report: no report configured — nothing here confirms any promise's paired case actually ran (horde.mjs config set gates.report.path ... and gates.report.format junit|tap|playwright-json)" — a repository that configures nothing sees no behaviour change
- **ran:** the distinction the acceptance draws: gates.report configured at reports/junit.xml while the gate writes reports/elsewhere.xml · **saw:** red with a different sentence — "config.gates.report names reports/junit.xml and the gate command left no such file in the tree it ran in, so 1 live promise(s) have a paired case with nothing to show it ran" — and the test asserts it does NOT say "no report configured"
- **ran:** the design question the issue does not answer: file-level (mirror/self) versus case-level (named) matching, each on its own fixture · **saw:** a named pairing (evidence: promises/kept.test.mjs#the one that counts) lands green while a NEIGHBOUR case in the same file fails, and is refused the moment its own named case is skipped; a mirror pairing requires the whole file — at least one case attributed to it and every one of them passing
- **ran:** TAP, read honestly: a TAP stream carries no file attribution at all, so a file-level pairing can only be matched by the paired file's own stem against the case name · **saw:** a green TAP run lands; a "# SKIP" line refuses; a TAP report with no line named after the file refuses saying "this report carries no file attribution at all ... Pair the promise as \"<file>#<case name>\", or have the gate write junit or playwright-json — both carry the file". The fallback is keyed to the parsed report, not the format name, so a JUnit writer that emits no file and no classname is told the same thing
- **ran:** Playwright JSON: a spec passing in the paired file lands; a spec whose result is timedOut refuses · **saw:** green — "pw.json (playwright-json)"; red — "adds-two-numbers: ... with \"adds two numbers\" failed, not passed". One entry per test, taking the LAST result, so a retry that passed reads as passed
- **ran:** empty is not a finding, the same discipline has-evidence/check.mjs takes: no promises at all; promises but none implemented; a promise kept only by an accepted artefact · **saw:** each green, with the item saying which — "there are no promises here to require a case for"; "none of this repository's 1 promise(s) reads \"implemented\""; "1 kept by an accepted artefact, which no runner runs". Nothing runs an artefact, so no report can ever say anything about one
- **ran:** deviation I chose on my own: config.gates.report.path may not be absolute or climb out with ".." · **saw:** refused before anything is read — "it has to stay inside the tree the gate ran in, because the only report that proves anything about this branch is the one that run left behind". Without it an absolute path reads a stale report from a tree nobody measured and reports it as proof; that is a false green in exactly the dimension this ticket exists to close
- **ran:** this is an item, not a sixth guard: nothing here refuses outright and no ask.mjs --kind lower answer waives it · **saw:** wired into checkGate itself, so a report-configured gate is green only when the report agrees — exactly the way a gate is not green today unless its exit code says so. A missing or failed case is fixed by writing it, un-skipping it or making it pass, which is what separates it from 021's guards
- **ran:** horde.mjs: no change needed for the config surface — setPath/getPath already write any dotted path · **saw:** horde.mjs config set gates.report.path "reports/junit.xml" and gates.report.format junit both work with zero code change there; every reader of cfg.gates names commit|team|trunk explicitly, so an object under gates.report collides with nothing
- **ran:** git log --oneline ded1474..HEAD && git status --short · **saw:** 855c27a path guard + cost note / b26c496 docs + CHANGELOG / 2fde212 the report reading itself / aa1e8fb in-progress; working tree clean. Only 5 lines were removed from land.mjs in the whole ticket, all inside checkGate, its comment and the USAGE item — no guard function from 021 was touched

