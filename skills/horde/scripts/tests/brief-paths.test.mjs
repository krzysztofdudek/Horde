import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absolutizePluginRoot } from '../brief.mjs';

// A brief a spawned agent reads must name the skill's scripts by an absolute path: the
// `${CLAUDE_PLUGIN_ROOT:-…}` form in the source files is for a person and for the manual
// drop-in, and a subagent is not guaranteed the variable at all.
test('brief.mjs: a rendered brief carries the absolute skill root, never the CLAUDE_PLUGIN_ROOT form', () => {
  const text = [
    'run ${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/queue.mjs list',
    'read ${CLAUDE_PLUGIN_ROOT}/reference/model.md',
    'and `${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/node.mjs` too',
  ].join('\n');
  const out = absolutizePluginRoot(text, '/abs/horde');
  assert.equal(out, [
    'run /abs/horde/scripts/queue.mjs list',
    'read /abs/horde/reference/model.md',
    'and `/abs/horde/scripts/node.mjs` too',
  ].join('\n'));
  assert.ok(!out.includes('CLAUDE_PLUGIN_ROOT'));
});

test('brief.mjs: the default root is the skill directory this script lives in', () => {
  const out = absolutizePluginRoot('${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/x.mjs');
  assert.match(out, /^\/.*\/skills\/horde\/scripts\/x\.mjs$/);
});
