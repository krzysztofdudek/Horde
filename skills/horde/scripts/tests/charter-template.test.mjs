// The charter template's own shape, read off disk — the one document in this skill that is both
// written by a tool and read by a person, and the one whose sections three separate parsers depend
// on standing where they stand.
//
// Three of its sections are read by machine and the rest by a human alone:
//
//   ## Acceptance  — _lib.mjs parseEvidenceRows
//   ## Quality     — _lib.mjs qualityPolicyIn
//   ## Goal / ## Non-goals / ## Constraints — refine.mjs charterForTerritory, which cuts the
//                    charter down to what one consultant may see
//
// Every one of them is read by slicing its heading up to the next "## ", so a section dropped into
// the middle of one truncates it silently. The evidence judgement is therefore checked here to be
// a full "## " section of its own, standing outside all of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_SECTION, catalogueCut } from '../wave.mjs';
import { qualityPolicyIn, parseEvidenceRows } from '../_lib.mjs';

const TEMPLATE = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'templates', 'charter.md');
const text = readFileSync(TEMPLATE, 'utf8');

// The headings, in the order they appear, as the parsers see them.
function headings(src) {
  return [...src.matchAll(/^## (.+)$/gm)].map((m) => ({ name: m[1].trim(), at: m.index }));
}

test('charter template: the evidence judgement is a section of its own', () => {
  const names = headings(text).map((h) => h.name);
  assert.ok(names.includes(EVIDENCE_SECTION), `no "## ${EVIDENCE_SECTION}" section: ${names.join(' · ')}`);
  assert.equal(names.filter((n) => n === EVIDENCE_SECTION).length, 1, 'exactly one of it');
});

test('charter template: the evidence judgement stands outside every machine-read section', () => {
  const list = headings(text);
  const mine = list.findIndex((h) => h.name === EVIDENCE_SECTION);
  const before = list[mine - 1];
  const after = list[mine + 1];

  // It is a sibling, not an insertion: the heading before it is a whole section and the heading
  // after it is the next whole section. Anything "inside" another section is, at this level of
  // heading, indistinguishable from cutting that section in two.
  assert.equal(before.name, 'Constraints');
  assert.match(after.name, /^Acceptance/);

  // And the three parsers still read what they are supposed to read.
  assert.equal(qualityPolicyIn(text), '{{quality | autonomous}}');
  assert.equal(catalogueCut(text), null, 'the catalogue is whole');
  assert.deepEqual(parseEvidenceRows(text), [], 'the template ships one all-empty row, which is no row');
});

test('charter template: a judgement section dropped inside the catalogue is caught, not absorbed', () => {
  // The failure this is all guarding against: someone puts the section between the catalogue's
  // header row and its data, and from that moment parseEvidenceRows — which every reader of the
  // catalogue goes through, the check on a ticket's --evidence ids included — sees a catalogue two
  // rows shorter than the chairman agreed to, with nothing wrong to see in the file.
  const filled = text.replace('| | | | |', '| E1 | the suite is green | api | |\n| E2 | the film plays | web | |');
  assert.equal(parseEvidenceRows(filled).length, 2);
  assert.equal(catalogueCut(filled), null);

  const cut = filled.replace(
    '| E2 | the film plays | web | |',
    `## ${EVIDENCE_SECTION}\n\nsomebody put it here\n\n| E2 | the film plays | web | |`,
  );
  assert.equal(parseEvidenceRows(cut).length, 1, 'the second row is invisible to the reader that matters');
  const damage = catalogueCut(cut);
  assert.ok(damage, 'and the damage is detected rather than absorbed');
  assert.equal(damage.read, 1);
  assert.equal(damage.present, 2);
  assert.equal(damage.lost, 1);
  assert.equal(damage.heading, EVIDENCE_SECTION);
});

test('charter template: a charter written before the section existed gains it, rather than being refused', async () => {
  const { upsertCharterSection } = await import('../wave.mjs');
  const old = text.split(`## ${EVIDENCE_SECTION}`)[0] + text.split('## Acceptance — the evidence catalogue')[1].replace(/^/, '## Acceptance — the evidence catalogue');
  assert.ok(!old.includes(`## ${EVIDENCE_SECTION}`), 'the fixture really has no such section');

  const gained = upsertCharterSection(old, EVIDENCE_SECTION, 'Evidence here is the suite.', { before: '## Acceptance' });
  assert.match(gained, new RegExp(`^## ${EVIDENCE_SECTION}$`, 'm'));
  assert.equal(catalogueCut(gained), null, 'and it lands outside the catalogue');
  assert.equal(qualityPolicyIn(gained), '{{quality | autonomous}}');

  // Written twice, it is replaced, not repeated — refine runs its own step more than once.
  const again = upsertCharterSection(gained, EVIDENCE_SECTION, 'Evidence here is the promises directory.', { before: '## Acceptance' });
  assert.equal([...again.matchAll(new RegExp(`^## ${EVIDENCE_SECTION}$`, 'gm'))].length, 1);
  assert.match(again, /the promises directory/);
  assert.doesNotMatch(again, /Evidence here is the suite\./);
});

// issue 120: the catalogue's fifth cell. The template's own header and separator carry the new
// column; the one placeholder data row is left exactly as it was (four cells, all empty) — an
// all-empty row parses as no row regardless of its own width, so nothing about it needed to
// change, and every one of this file's other tests (and every other test in this suite that keys
// off the literal placeholder text) still finds exactly what it always found.
test('charter template: the header carries the new fifth column; the placeholder row is untouched', () => {
  assert.match(text, /^\| id \| evidence \| node \| reproduced by \| evidence class \|$/m);
  assert.match(text, /^\|---\|---\|---\|---\|---\|$/m);
  assert.match(text, /^\| \| \| \| \|$/m, 'the one placeholder row is still four cells, unchanged');
});

test('charter template: a five-cell row parses with its class; a five-cell row and a four-cell row stand together without tearing the catalogue', () => {
  const filled = text.replace(
    '| | | | |',
    '| E1 | the checkout completes | web | scout | e2e scenario |\n| E2 | an old-shape row beside it | api | |',
  );
  assert.equal(catalogueCut(filled), null, 'a five-cell row and a four-cell row together: the catalogue is still whole');
  assert.deepEqual(parseEvidenceRows(filled), [
    {
      id: 'E1', evidence: 'the checkout completes', node: 'web', reproducedBy: 'scout', evidenceClass: 'e2e scenario',
    },
    {
      id: 'E2', evidence: 'an old-shape row beside it', node: 'api', reproducedBy: '', evidenceClass: '',
    },
  ]);
});

test('charter template: an accepted prototype\'s own five-cell row is never read as a second catalogue row for the same id, and never makes catalogueCut think one escaped its section', async () => {
  const { PROTOTYPE_SECTION, recordPrototypeAcceptance } = await import('../wave.mjs');

  const filled = text.replace('| | | | |', '| E1 | the checkout completes | web | scout | e2e scenario |');
  // The prototype accepted for E1 carries E1's own id, and five cells of its own — the same width
  // a catalogue row can now have — but stands in "## Prototypes accepted", a section of its own.
  const withPrototype = recordPrototypeAcceptance(filled, {
    id: 'E1', ticket: '004-shift-board', sha256: 'a'.repeat(64), acceptedBy: 'Anna Kowalska', at: '2026-01-01',
  });
  assert.match(withPrototype, new RegExp(`^## ${PROTOTYPE_SECTION}$`, 'm'));
  assert.equal(catalogueCut(withPrototype), null, 'the accepted-prototype table is not mistaken for a torn catalogue');
  const rows = parseEvidenceRows(withPrototype);
  assert.equal(rows.length, 1, 'still exactly the one real catalogue row, not a second one from the prototype table');
  assert.equal(rows[0].evidenceClass, 'e2e scenario');
});
