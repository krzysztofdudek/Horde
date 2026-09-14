# 021 · nic co chroni nie slabnie

**Status:** done
**Kind:** gap
**Priority:** 1
**Tier:** strong
**Tags:** kontrakt
**Files:** skills/horde/scripts/land.mjs, skills/horde/scripts/ask.mjs, SKILL.md, reference/model.md, skills/horde/scripts/README.md
**Found by:** jarl, reading every file of Horde
**Where:** skills/horde/scripts/land.mjs (straż prawa jako wzór czytania dwóch drzew); skills/horde/scripts/ask.mjs kind lower

## What
Jedna straż dwudrzewna przy lądowaniu, obok straży prawa: nic, co chroni, nie słabnie bez odpowiedzianego pytania. Prawo (jest dziś), dowody (obietnice: status nie spada z implemented, sparowany przypadek istnieje, nie przybywa znaczników pominięcia; testy: liczba plików testowych w testGlobs i liczba asercji per plik nie maleje; bilet dotykający istniejącej obietnicy pokazuje czerwień przez rewersję albo mutację), bramki (config.gates.*, hooki pre-commit i pre-push, workflow CI, protectedPaths).

## Why
Dziś tylko prawo jest chronione podpisem klienta. Testy i bramki wolno osłabić w tej samej ręce, która pisze kod.

## Acceptance
Pytanie `lower` dostaje pole celu: aspect, evidence, gate. Bez odpowiedzianego pytania straż odmawia. Sześć przypadków testowych: usunięty test, usunięta asercja, dodany skip, obietnica cofnięta na planned, zmieniona komenda bramki, usunięty hook; każdy odmawia; z odpowiedzią lower na dany cel przechodzi i konsumuje scope once. Liczenie asercji po zamkniętej liście per język, bez progu, tylko nierosnąco. SKILL.md dostaje jedno zdanie reguły dla agenta.

Dowód, którego oczekuję: skills/horde/scripts/tests/law-guard.test.mjs, skills/horde/scripts/tests/land.test.mjs.

## Evidence

- **ran:** cd skills/horde/scripts && HORDE_TEST_YG=... timeout 2400 node --test tests/law-guard.test.mjs · **saw:** # tests 51 / # pass 51 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0 (was 32/32/0 before this ticket; 19 new cases)
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG=... timeout 3000 node --test tests/land.test.mjs · **saw:** # tests 95 / # pass 95 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0 (was 94/94/0 before this ticket; 1 new batch-screen case)
- **ran:** cd skills/horde/scripts && HORDE_TEST_YG=... timeout 1200 node --test tests/docs.test.mjs tests/ask.test.mjs tests/horde.test.mjs · **saw:** # tests 140 / # pass 138 / # fail 0 / # skipped 2 — both skips pre-existing and environmental (running as root, chmod cannot force a write to fail)
- **ran:** the six acceptance cases, each as a refusing test and an answered twin: removed test file, removed assertion, added skip marker, promise back to planned, changed gate script, removed commit hook · **saw:** each refuses naming its own target and case (evidence:tests/second.test.mjs (test removed|assertions dropped|skip added), evidence:adds-two-numbers (promise parked), gate:gate.sh (gate changed), gate:.husky/pre-commit (gate removed)); each lands with an answered lower ask naming that target, and each writes **Consumed:** ticket NNN at <sha> into decisions.md
- **ran:** read checkRevertTest (land.mjs) and the two tests that pin it: land.test.mjs 'a modified existing test file is checked for red the same as a new one' and 'a ticket's **Mutate:** command runs against the branch's own tip and the new tests must go red on it' · **saw:** the 'ticket touching an existing promise shows red through reversion or mutation' clause already holds with no new code: item 4 requires every new OR modified test file matching testGlobs to fail, either extracted onto the revert base or under the ticket's **Mutate:** command, and the file keeping a promise is such a file. Nothing was built for it
- **ran:** design decision on the ask target field: kept --aspect as the one flag and **Aspect:** as the one field, widening only what values it is documented to accept · **saw:** zero churn to ask.mjs parsing, decisions.md shape, findAnswer/consumeAnswer or any existing test; three collision-free spellings instead — a bare rule id (unchanged), evidence:<promise id|test path>, gate:<path>. Each guard calls findAnswer for its own specific target, never a blanket category waiver
- **ran:** deviation from the issue's own list: config.protectedPaths is not watched by the gate guard · **saw:** item 3 (scope) already refuses any branch that so much as touches a protected path, with no client answer able to let it through; a second refusal naming an answer that still could not land the change would mislead a worker into asking the client for nothing. Recorded in scripts/README.md and in the code
- **ran:** git log --oneline -3 && git status --short · **saw:** 0fd87a6 keep the new guards cheap / 574994e docs+CHANGELOG / d62e66f the guards themselves; working tree clean
- **ran:** HORDE_TEST_YG=... node --test tests/law-guard.test.mjs tests/land.test.mjs, merger's own run on the merged tip · **saw:** 146 tests, 146 pass, 0 fail, 0 skipped
- **ran:** HORDE_TEST_YG=... node --test tests/docs.test.mjs tests/ask.test.mjs tests/horde.test.mjs tests/drill.test.mjs tests/tick.test.mjs tests/queue.test.mjs, merger's own broader regression sweep on the merged tip · **saw:** 303 tests, 301 pass, 0 fail, 2 pre-existing unrelated skips

