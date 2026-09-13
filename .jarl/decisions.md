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
