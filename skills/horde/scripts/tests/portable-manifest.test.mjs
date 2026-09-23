// Copilot (Agent Plugins 1.0) and Codex read the portable `plugin.json` at the repository root before
// any host-specific manifest; Claude Code and Cursor keep reading their own. One plugin, several files:
// this holds them to one name, one version and one description.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

test('the portable plugin.json names the Agent Plugins schema and agrees with every host manifest', () => {
  const portable = read('plugin.json');
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  for (const rel of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    const host = read(rel);
    for (const field of ['name', 'version', 'description']) {
      assert.equal(portable[field], host[field], `${rel} says a different ${field}`);
    }
  }
});
