import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Task 014's own definition of done: after the seat cassation, no file under skills/horde/
// mentions roster.mjs, dissent.mjs or verify.mjs by name — the three tools deleted whole. Reads
// every file as raw bytes decoded permissively (never `file`'s or a plain grep's "looks binary,
// skip it" heuristic), because escalate.mjs carries a literal NUL byte (its composite-key
// separator) that would otherwise make this exact scan silently miss a live import. Counts the
// files it opened against a fresh `readdirSync` walk of the same tree, so a skipped file can
// never produce a false green.

const SKILLS_HORDE_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const SELF = fileURLToPath(import.meta.url);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    // This file itself names the three tools literally, to say what it's checking for — the one
    // structurally necessary exception, the same way the root CHANGELOG.md names them to record
    // that they're gone.
    if (entry.isFile() && full !== SELF) out.push(full);
  }
  return out;
}

test('skills/horde/: no file mentions roster.mjs, dissent.mjs or verify.mjs by name', () => {
  assert.equal(SKILLS_HORDE_DIR.endsWith(join('skills', 'horde')), true, `sanity check on the walked root: ${SKILLS_HORDE_DIR}`);

  const allFiles = walk(SKILLS_HORDE_DIR);
  assert.ok(allFiles.length > 50, `expected a real tree, found only ${allFiles.length} files under ${SKILLS_HORDE_DIR}`);

  const offenders = [];
  let opened = 0;
  for (const file of allFiles) {
    // Buffer, not a string-mode read: a NUL byte (escalate.mjs's composite-key separator) must
    // not make this reader treat the file as binary and skip it — every byte is scanned.
    const buf = readFileSync(file);
    opened += 1;
    const text = buf.toString('latin1');
    for (const name of ['roster.mjs', 'dissent.mjs', 'verify.mjs']) {
      if (text.includes(name)) offenders.push(`${file}: mentions ${name}`);
    }
  }

  // The scan's own count must match a fresh directory listing — the one thing that would let a
  // silently-skipped file produce a false green.
  const recount = walk(SKILLS_HORDE_DIR).length;
  assert.equal(opened, allFiles.length, 'every file found by the walk must have been opened');
  assert.equal(opened, recount, 'the walk must not have changed between listing and scanning');

  assert.deepEqual(offenders, [], `found live mentions of a deleted tool:\n${offenders.join('\n')}`);
});
