import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missionWordsIn } from '../land.mjs';

// The graph is plan-agnostic: a charter says what a node is, never which wave touched it.
test('land.mjs missionWordsIn: names the plan words a charter or graph commit must not carry', () => {
  assert.deepEqual(missionWordsIn('Renders the brief document. Wave 2 rewrote it for ticket 013 of this mission.'), ['wave', 'ticket NNN', 'mission']);
  assert.deepEqual(missionWordsIn('Proves E4 by mutation; see .temp/notes.md'), ['E<n> evidence id', '.temp/ path']);
  assert.deepEqual(missionWordsIn('Owns the interview session and its repository port. E2E specs live beside it.'), []);
  assert.deepEqual(missionWordsIn(''), []);
});
