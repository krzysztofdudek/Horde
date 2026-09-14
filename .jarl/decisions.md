# Decisions

## 2026-09-13 · koszt-wylatuje
Koszt i limity wylatują z Hordy w całości. Żadne issue nie zachowuje ich w części.

## 2026-09-13 · jedno-wydanie-6-0-0
Wszystko na tej gałęzi to poprawki do 6.0.0: wpisy pod [6.0.0], wersja bez zmian; na końcu tag i release v6.0.0 usunięte i zrobione od nowa, żeby wyglądały jak jedyne.

## 2026-09-13 · srodowisko-poza-horda
Środowisko testowe jest dostarczane poza Hordą. Horda wykrywa, co zastała, i pracuje na tym; nigdy go nie buduje.

## 2026-09-13 · jarl-tylko-na-galezi
.jarl/ żyje tylko na tej gałęzi i znika ostatnim commitem przed scaleniem do main.

## 2026-09-13 · jarl-zostaje-0-1-0
Każda zmiana w JarlSkill w trakcie tej pracy idzie pod 0.1.0: wersja w manifestach i sekcja CHANGELOG bez zmian, wpisy dopisywane do istniejącej sekcji 0.1.0.

## 2026-09-13 · stray-jarl-state-in-merges
Stray .jarl/ content (bookkeeping filed by the reeve/jarl, e.g. an issue file or log lines) that lands inside a merge commit because of a shared-checkout race is not grounds to bounce that merge. Pushed history on the feature branch is never rewritten to remove it. .jarl/ never reaches main — it is removed in the last commit before the branch merges — so no shipped code is affected. A reviewer finding only stray .jarl state, with the worker's actual diff otherwise meeting its acceptance line, approves; note the stray content in the issue's evidence instead of routing it back to the worker.

## 2026-09-13 · stop-holds-landing-too
Issue 028: an open 'stop' question holds landing too, not just new dispatch -- the table's own graduated ordering (stuck < charter < lower < stop, and lower alone already proves a landing is a blockable thing) means 'wszystko' (everything) in stop's row has to be a superset of what lower blocks. Ruled by the jarl after independently reading the issue's Polish text; the worker's original dispatch-only reading, while a reasonable design preference, did not match the specified scope.

## 2026-09-14 · tk-boundary-cwd-is-intentional
Issue 040: tk.mjs new/edit's Files/Consumes/Produces checks (checkFilesInBoundary, checkConsumesHaveProducers) read the graph from cwd, not the horde's trunk. Confirmed intentional, not a repeat of 037. node.mjs's own dispatcher already states the tool set's actual rule (main(), comment above its resolveTree call): an ordinary graph read defaults to cwd, and --horde is only ever the horde-store disambiguator, never a second signal for trunk -- 'a repository running more than one horde still passes --horde on an ordinary read, and cwd -- not trunk -- is still where its uncommitted graph edits are.' Only a graph WRITE (log --run, promote, demote) special-cases --horde-alone to mean trunk, for the write-safety refusal. queue.mjs plan/quality's own --horde-alone-means-trunk is the sole read-time exception, and tree.test.mjs's header comment calls it out by name as 'the one place' -- that exact exception is what 037 tried to broaden to every command and got reverted (f551100) over, pending the client's still-open ruling on ask a-002. tk.mjs's boundary/port checks were never part of that exception; they already match node.mjs's documented default, so switching them to trunk (037's fix pattern) would have been the wrong move here, not a missed one. Verified empirically: patched checkFilesInBoundary/checkConsumesHaveProducers to resolveTree({horde}) and ran tests/tk.test.mjs -- 64/64 still pass either way, so no existing test pins cwd here (unlike 037's tree.test.mjs); the deciding evidence is the documented design intent, not test breakage. Outcome: docs-only. tk.mjs's USAGE and skills/horde/scripts/README.md's tk.mjs section now say the check reads cwd, --horde only selects the ticket store, and name queue.mjs plan/quality as the one exception. No new issue filed -- this is the same open question already tracked by 037/a-002, and tk.mjs was simply never on the wrong side of it.
