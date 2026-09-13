# Goal

Poprawki do Hordy 6.0.0: dokumentacja i kod mówią to samo, kruchości usunięte, luki wobec wizji misji domknięte, koszt usunięty w całości. Wydanie 6.0.0 zrobione od nowa jako jedyne.

## Assumptions

- Środowisko testowe jest dostarczane poza Hordą. Horda pracuje na tym, co zastanie, i nigdy go nie buduje.
- Horda jest ograniczona do misji. Kierunek między misjami i uczenie się między misjami są poza tą pracą.
- Wszystko, co tu powstaje, to poprawki do 6.0.0: wpisy w CHANGELOG pod `[6.0.0]`, wersja bez zmian, na końcu wydanie 6.0.0 od nowa jako jedyne.
- `.jarl/` żyje tylko na tej gałęzi i znika ostatnim commitem przed scaleniem do main.

## Rules that apply here

- Dowód zamiast raportu, pytanie zamiast zgadywania, prosty język do klienta, architektura sprawdzona przed lądowaniem, nic, co chroni, nie słabnie bez słowa klienta.
- Zasady rodziny: żadnej nowej strojonej stałej, progi mają pochodzenie, incydent nigdy nie jest automatyczny, Horda nigdy nie pushuje, rdzeń Yggdrasila nietknięty.
- Kod i wszystko, co się wysyła adopterom, po angielsku; sprawy w `.jarl/` po polsku.
- Każde issue to jedna zmiana: kod, test, dokumentacja (`reference/model.md`, `scripts/README.md`, `SKILL.md`, role) i wpis w CHANGELOG w jednym commicie; `npm test` w `skills/horde/scripts/` zielone.

---

# Wizja: Horda, jedna misja, od klienta do klienta

Horda to software house na jedną misję. Klientem jest użytkownik. Graf Yggdrasila jest prawem,
warstwa dowodów jest kontraktem, a wszystko pomiędzy jest zapleczem, które klienta nie obchodzi.
Ten dokument mówi, co Horda robi w granicach misji i czego nie robi wcale. Każde issue w `issues/`
wskazuje jedną z sekcji poniżej.

## 1. Granice

Poza Hordą są cztery rzeczy i Horda ich nie udaje:

- Środowisko testowe. Jest dostarczone. Horda wykrywa, co zastała (obietnice, suita, coś, czego nie
  umie czytać, nic), wpisuje to do chartera i pracuje na tym. Nigdy nie stawia środowiska sama.
- Kierunek między misjami. Misja ma charter i tylko charter. Co zostaje po misji, jest zapisane
  tak, żeby następna misja mogła to przeczytać, ale żadna misja nie zarządza następną.
- Uczenie się między misjami. Retrospektywa proponuje reguły i zostawia ślad w logach komponentów.
  Nic więcej nie przechodzi między misjami inaczej niż przez graf i archiwum.
- Pieniądze. Koszt i limity wylatują z Hordy w całości: nie są tematem ani tej pracy, ani Hordy.

## 2. Front: wejście klienta

- Klient mówi po ludzku, Horda odpowiada po ludzku. Charter składa się z wierszy, z których każdy
  jest czymś, co klient może zobaczyć, gdy się wydarzy. Wiersz, którego klient nie umie opisać,
  dostaje najpierw bilet prototypu: coś, co wygląda jak docelowe, choć takie nie jest, i którego
  jedynym dowodem jest akceptacja klienta.
- Jedyny kanał pytań to `ask`: `stop`, `stuck`, `lower`, `charter`. Odpowiedź staje się decyzją
  i decyzję czyta straż przy lądowaniu. Nie ma piątego kanału.
- Klient może dyktować bilety. Bilet spoza chartera (węzeł poza terytoriami misji, dowód bez
  wiersza) nie wchodzi do kolejki; Horda mówi, co się nie zgadza, i które pytanie `charter` to zmienia.
- Otwarte pytanie blokuje tylko to, co od niego zależy. Reszta misji idzie dalej.

## 3. Kontrakt: dowody

- Obietnica to jeden plik w języku produktu sparowany 1:1 z tym, co jej pilnuje. Pakiet `promises`
  wymusza kształt, język, parowanie w obie strony i zgodność treści z testem. To już jest.
- Lądowanie odtwarza dowody z chartera i wymaga, żeby sparowany przypadek każdej żywej obietnicy
  faktycznie się uruchomił i przeszedł na sha, które ląduje. Obecność pliku nie jest dowodem.
- Nic, co chroni, nie słabnie bez słowa klienta. Jedna straż przy lądowaniu, czytająca bazę i
  czubek: prawo (reguły, daty przeglądu, wyciszenia), dowody (obietnice, testy, asercje, znaczniki
  pominięcia), bramki (komendy, hooki, CI, ścieżki chronione). Osłabienie przechodzi tylko przez
  odpowiedziane pytanie `lower` z nazwanym celem. To samo zdanie jest regułą agenta w SKILL.md.
- Warstwa „nic” jest głośna, nie cicha. Gdy repozytorium nie ma dowodów, każde lądowanie i każde
  zamknięcie fali mówi, które wiersze trzymają się tylko na słowo.

## 4. Zaplecze: samozarządzająca misja

- Pętla: `refine` (cięcie na terytoria, konsultanci, orzeczenie architekta, charter) → `plan`
  (graf zależności z portów i deklaracji) → `tick` (odzyskanie, lądowanie, przydział, zamknięcie)
  → worker na bilet we własnym worktree → `land` (straże, dziewięć punktów, merge z trailerami)
  → zamknięcie fali (pokrycie dowodów, równoległość, indeks jakości, promocje, dyff prawa, audyt)
  → `retro` → `done`.
- Trunk pisze wyłącznie skrypt lądowania. Każdy stan mutuje przez skrypt. Każdy plik dzielony
  między procesami ma jedną blokadę.
- Dokumentacja i kod mówią to samo, i jest test, który to sprawdza. Składnia w briefie, której
  narzędzie odmawia, to defekt.
- Biblioteka nie kończy procesu. Odmowa to błąd, który łapie `main()`. Pętla `tick --watch`
  przeżywa każdą odmowę do następnego interwału.
- Każda stała ma pochodzenie: pomiar, ograniczenie transportu albo decyzja klienta, zapisane obok
  niej. Nowa stała bez pochodzenia nie wchodzi.
- Rozmiar zmiany jest jedynym sygnałem ryzyka, który przetrwał pomiar. Plan i lądowanie pokazują
  rangę biletu wśród biletów misji, bez progu; architekt decyduje o podziale.

## 5. Księga misji

- Misja zostawia po sobie: wynik każdego lądowania, dziennik, retrospektywę, dyff prawa,
  odpowiedzi klienta, i to wszystko w archiwum, które następna misja umie przeczytać
  (`horde.mjs history`, brief konsultanta z wpisami dla jego terytorium).
- Los biletu w misji jest zapisany także po lądowaniu: wylądował, cofnięty, wrócił (ten sam
  wiersz dowodu znów czerwony). Zamknięcie fali i retrospektywa liczą losy, nie tylko merge.
- `blame` prowadzi od linii kodu do biletu, jego dowodów i werdyktów, przez misje żywe i archiwalne.

## 6. Uczenie się w obrębie misji

- Retrospektywa sortuje wszystko, co misja zapisała i czego nikt nie przeczytał dwa razy, na
  reguły, gust i rzeczy niewyrażalne. Propozycje reguł składa człowiek; Horda nie pisze prawa sama.
- Powtarzająca się odpowiedź klienta staje się propozycją reguły dopiero, gdy naprawdę jest ta
  sama odpowiedź, nie gdy jest ten sam rodzaj pytania.
- Reguła wspina się po drabinie wyłącznie na dowodach: zielony korpus przypadków, czyste fale,
  zero odmów. Obniżenie jest decyzją klienta.

## 7. Co jest poza tą pracą, z nazwy

Runner zewnętrzny poza naprawą dokumentacji, sondy produkcyjne z zegarem
świeżości, budowa środowiska syntetycznego, kierunek produktu ponad misją. Wszystko to jest
nazwane tutaj po to, żeby żadne issue nie próbowało tego przemycić.
