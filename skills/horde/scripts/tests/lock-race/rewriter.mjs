// Test-only: a writer that plays by the rules, slowly.
//
//   usage: rewriter.mjs <ticket|leases|decisions|charter> <file> <ready-marker> <hold-ms> <text-to-add> [<ticket-dir>|<horde>]
//
// It takes the real lock for <file> — the shipped function, imported from the shipped script —
// reads the file, writes <ready-marker> so the test knows the lock is held and the read is done,
// waits until the file changes or <hold-ms> pass, then writes back what it read plus <text-to-add>.
// That is the shape of every read-modify-write in the tool set, stretched out so another writer
// lands inside it every run.
//
// A second writer that honours the same lock waits for this one and then works on the file as this
// one left it: both changes survive. A second writer that ignores the lock writes during the hold,
// and this one's write-back then erases it. The test reads the file afterwards and asks whether
// both changes are there.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [kind, file, marker, holdRaw, addition, extra] = process.argv.slice(2);
const hold = Number(holdRaw);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rewrite() {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(marker, `${process.pid}\n`);
  // Held until another writer changes the file under it, or for <hold-ms> when none does. A writer
  // that ignores the lock shows up here as a change, and is then erased by the write-back below; a
  // writer that honours it changes nothing until this one lets go.
  const deadline = Date.now() + hold;
  while (Date.now() < deadline) {
    const now = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (now !== before) { sleepSync(50); break; }
    sleepSync(10);
  }
  if (kind === 'leases') {
    const doc = before ? JSON.parse(before) : { leases: {}, history: [] };
    const extraLease = JSON.parse(addition);
    doc.leases = { ...doc.leases, ...extraLease };
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  } else {
    writeFileSync(file, before + addition);
  }
}

if (kind === 'ticket') {
  const { withTicketLock } = await import('../../_lib.mjs');
  withTicketLock(extra, rewrite);
} else if (kind === 'leases') {
  const { withLeasesLock } = await import('../../_lib.mjs');
  withLeasesLock(rewrite);
} else if (kind === 'decisions') {
  const { withDecisionsLock } = await import('../../decide.mjs');
  withDecisionsLock(extra, rewrite);
} else if (kind === 'charter') {
  const { withCharterLock } = await import('../../_lib.mjs');
  withCharterLock(extra, rewrite);
} else {
  throw new Error(`no such kind: ${kind}`);
}
