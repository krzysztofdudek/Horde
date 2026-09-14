# 120 · wave close cannot report catalogue rows per evidence class

**Status:** open
**Kind:** gap
**Priority:** 3
**Tier:** standard
**Tags:** kontrakt, pakiet
**Files:** skills/horde/scripts/wave.mjs
**Found by:** issue 024 worker
**Where:** skills/horde/scripts/wave.mjs (computeEvidence, cmdClose), skills/horde/scripts/_lib.mjs (parseEvidenceRows), skills/horde/templates/charter.md

## What

Issue 024's third acceptance line — "zamknięcie fali raportuje wiersze per klasa" (the wave close
reports rows per class) — was left unbuilt when 024 landed. The other two lines (the settled lists,
and drills on an unknown value) are done: `class` and `executor` now exist on a promise's
frontmatter and an unrecognised value is refused. What could not be built is the reporting, because
nothing today connects a charter's evidence row to an individual promise file.

## Why

The two things are different data with no link between them.

- A charter row is a line in `hordes/<h>/charter.md`: `| id | evidence | node | reproduced by |`.
  `id` is E1, E2…; `evidence` is free prose ("a test, a scenario, a recording, a screenshot, a
  number" — `reference/discipline/framing.md`); `node` is a graph node; `reproduced by` is a
  verifier's or gate's name that `wave.mjs close` fills in itself. No cell names a file.
- A promise is a markdown file in the adopting repository's promises directory, and `class` is a
  field of its frontmatter.

Nothing pairs the two, in either direction:

- A ticket's `**Evidence:**` names charter row ids (E2, E5), never a promise file.
- `has-evidence`'s four pairings (`mirror`, `named`, `self`, `artefact`) pair a promise with the
  test that keeps it, not with a charter row.
- `horde.mjs`'s `detectPromises` touches the promises directory exactly once, at mission cut, to
  count files carrying a `status:` line for one prose paragraph in the charter. It never reads
  `id`, and the result is a paragraph, not a per-row mapping.
- The `node` cell is the only shared vocabulary, and it is many-to-many: one node can hold fifty
  promises, so a row naming a node says nothing about which promise's class it would inherit.

Two further facts a fix has to deal with:

- The `promises` package is an optional offer made only to a repository that has no evidence layer
  of its own. In most missions there are no promise files at all, so a per-class breakdown would
  report "unknown" for every row.
- "Class" is already taken in Horde's own vocabulary: `_lib.mjs`'s `DEFAULT_CLASSES`
  (light/standard/heavy/max) is the model-weight ladder, and `wave.mjs close` already reports
  against it. A second, unrelated "class" in the same command's output needs a different word or a
  deliberate decision to overload one.

A contrived link was deliberately not built. The plausible fix — a fifth column on the catalogue —
is a charter schema change: `parseEvidenceRows` reads four cells, `catalogueRowsAnywhere` filters
on `cells.length === 4` (and that four-cell count is exactly what keeps the five-column prototype
table invisible to every catalogue reader), and `setReproducedBy` writes `cells[4]` of a six-piece
split. Every charter already written has four columns. That is an architect's call and the
client's, not a worker's.

## Acceptance

A decision first, then whatever it calls for. The question to settle: should a charter's evidence
row carry the kind of proof it rests on at all — and if so, is that a column of its own on the
catalogue, or is it read off a promise file through a pairing that does not exist yet? Only once
that is answered does `wave.mjs close` have something true to count. Whatever lands keeps every
charter already written readable, and keeps the prototype table invisible to catalogue readers.

## Evidence
