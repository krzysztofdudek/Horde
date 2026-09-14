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

## 2026-09-14 · 108-no-evidence-layer-exempts-revert-test
Krzysztof ruled: when a mission's charter judges 'no evidence layer' (no test suite, no promises directory, nothing named like a test), checkRevertTest in land.mjs should exempt every ticket from the revert-test check entirely — return ok:true immediately, citing the charter's own judgment, rather than refusing on empty testGlobs or requiring a per-ticket '**No new tests:**' declaration. Rationale: the check's whole premise (did this change add/touch a test file) does not apply to a mission whose evidence catalogue is verified by hand (a scenario, a screenshot) rather than by running code — asking for a test file there is the wrong question, not a missing answer. The alternative considered and rejected: treating 'no test convention at all' as a hard, permanent block on landing anything in such a repository.

## 2026-09-14 · ask-002
**Question:** Issue 037 filed queue.mjs plan/quality as a bug (no --horde, one horde in repo → should read trunk, not cwd) and a worker's fix made resolveTree always use the resolved horde's trunk when one exists. That broke a pre-existing, deliberate test in tree.test.mjs asserting the opposite: no --tree, no --horde → cwd, even with a horde present. Both can't be the documented default. Which is correct: (a) no --horde always means cwd, full stop — 037 is invalid, close it; or (b) no --horde should mean trunk when exactly one horde exists, and tree.test.mjs's existing case needs to change instead; or (c) something more specific (e.g. this distinction should key off something else, like whether a mission is actively running vs a bare repo)?
**Answer:** Krzysztof: always cwd, full stop. No --horde never means trunk, regardless of how many hordes exist in the repository. Issue 037 is invalid, closed. horde.mjs done's own resolveTree call (issue 113) currently does the broader thing unprompted and needs narrowing to flags.horde, matching tick.mjs (041) and land.mjs (109) — its current behavior is a bug to fix, not a precedent to extend. Issues 111 and 114, both held on this ruling, are now unblocked and should state/apply this plainly.

## 2026-09-14 · ask-001
**Question:** Issue 024 needs client-approved closed lists for a promise's optional 'class' (evidence type: e2e scenario, hermetic test, mutation, recorded stub, artifact, client testimony) and 'executor' (who reproduces it: gate, guard, worker, client) fields before implementation can start. Proposed lists are in the issue body's Where/Acceptance. Holding 024 open, not raised.
**Answer:** Krzysztof: approved as proposed, no changes. class = e2e scenario, hermetic test, mutation, recorded stub, artifact, client testimony; executor = gate, guard, worker, client. Issue 024 can move to implementation.
