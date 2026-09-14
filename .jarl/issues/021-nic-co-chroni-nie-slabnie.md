# 021 · nic co chroni nie slabnie

**Status:** in-progress
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

