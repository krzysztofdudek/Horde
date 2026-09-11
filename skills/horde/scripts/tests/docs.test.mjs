// The documentation's own shape, read off disk — modelled on the deleted brief-paths.test.mjs's
// idiom: these tests read files and compare what they say against each other or against the code,
// never render a brief or run a tool. The one scan that walks arbitrary files (the retired-role
// scan, below) decodes as latin1 rather than utf8, because escalate.mjs carries a literal NUL byte
// (its composite-key separator) that would make a naive reader — or a plain `grep` — treat the file
// as binary and skip it; every other test here reads a named file as real utf8 text instead, since
// it has to compare actual prose (em dashes, checkmarks), not just look for an ASCII substring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, readdirSync, existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const REPO_ROOT = join(SKILL_DIR, '..', '..');
const SCRIPTS_DIR = join(SKILL_DIR, 'scripts');

// latin1: never chokes on a NUL byte (escalate.mjs carries one, its composite-key separator) —
// used only for the retired-role-name scan below, which only ever looks for plain ASCII words and
// does not care that a multi-byte UTF-8 character elsewhere decodes to mangled bytes under it.
function readRaw(path) {
  return readFileSync(path).toString('latin1');
}

// utf8: for every other test here, which reads real prose (em dashes, checkmarks) and needs it
// decoded correctly rather than merely decoded without crashing.
function readText(path) {
  return readFileSync(path, 'utf8');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    out.push(full);
  }
  return out;
}

// ---- no file names a retired role ---------------------------------------------------------

// The scan is scoped to the skill's own prose — SKILL.md and reference/** — not the whole of
// skills/horde/. A repository-wide word ban on "owner", "verifier" and "steward" catches ordinary
// English used for something else entirely: Yggdrasil's own yg-node/1 `owner` field, generic
// `--by <name>`-style CLI flags, and roster.json's own pre-migration compatibility reads (still
// legitimate code, kept on purpose so an old mission's state does not break a fresh binary).
// Scoping the ban to the text a person or an agent actually reads to learn the roles is the
// difference between a real regression and hundreds of false positives across the tool set.
const RETIRED_ROLE_RE = /\b(steward|owner|verifier|auditor|counsel)\b/i;

test('the skill\'s prose (SKILL.md, reference/**) names no retired role', () => {
  const files = [join(SKILL_DIR, 'SKILL.md'), ...walk(join(SKILL_DIR, 'reference'))];
  assert.ok(files.length > 5, `expected a real reference/ tree, found ${files.length} file(s)`);
  const offenders = [];
  for (const file of files) {
    const text = readRaw(file);
    const m = RETIRED_ROLE_RE.exec(text);
    if (m) offenders.push(`${file}: names "${m[1]}"`);
  }
  assert.deepEqual(offenders, [], `retired role named in prose:\n${offenders.join('\n')}`);
});

// ---- the model page replaces topology.md ---------------------------------------------------

test('reference/topology.md no longer exists, and reference/model.md carries Mechanics and Runner', () => {
  assert.equal(existsSync(join(SKILL_DIR, 'reference', 'topology.md')), false);
  const model = readText(join(SKILL_DIR, 'reference', 'model.md'));
  assert.match(model, /^## Mechanics$/m);
  assert.match(model, /^## Runner$/m);
});

// ---- Agent Teams is optional, not a requirement --------------------------------------------

function section(text, heading, nextHeadingRe = /^## /m) {
  const start = text.indexOf(heading);
  assert.ok(start !== -1, `no "${heading}" heading found`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(nextHeadingRe);
  return next === -1 ? rest : rest.slice(0, next);
}

test('README\'s Requirements section names neither Agent Teams nor a specific old Yggdrasil version', () => {
  const readme = readText(join(REPO_ROOT, 'README.md'));
  const requirements = section(readme, '## Requirements');
  assert.doesNotMatch(requirements, /Agent Teams/);
  assert.doesNotMatch(readme, /5\.9\.0/, 'README names a stale minimum Yggdrasil version');
});

test('README carries the "two keys" sentence only in the family table, nowhere else', () => {
  const readme = readText(join(REPO_ROOT, 'README.md'));
  const familyHeading = readme.indexOf('## The Yggdrasil family');
  assert.ok(familyHeading !== -1, 'README has no "## The Yggdrasil family" section');
  const before = readme.slice(0, familyHeading);
  assert.doesNotMatch(before, /two keys/i);
});

test('CLAUDE.md never states Agent Teams as a requirement', () => {
  const claude = readText(join(REPO_ROOT, 'CLAUDE.md'));
  assert.match(claude, /Agent Teams/, 'CLAUDE.md should still explain the runner, just not require it');
  assert.doesNotMatch(claude, /mechanics depend on/i);
  assert.doesNotMatch(claude, /Agent Teams[^.]*\b(is required|must be (on|enabled|turned on))\b/i);
  assert.match(claude, /optional/i);
});

// ---- SKILL.md's commands and scripts/ agree, in both directions ---------------------------

function mjsNamesIn(text) {
  return new Set([...text.matchAll(/\b([a-zA-Z_]+\.mjs)\b/g)].map((m) => m[1]));
}

test('every *.mjs named in SKILL.md exists in scripts/, and every scripts/*.mjs (but _lib.mjs) is named in SKILL.md or scripts/README.md', () => {
  const skill = readText(join(SKILL_DIR, 'SKILL.md'));
  const scriptsReadme = readText(join(SCRIPTS_DIR, 'README.md'));
  const named = mjsNamesIn(skill);
  const onDisk = new Set(readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')));

  const namedButMissing = [...named].filter((n) => !onDisk.has(n));
  assert.deepEqual(namedButMissing, [], `SKILL.md names a script that does not exist: ${namedButMissing.join(', ')}`);

  const documentedEverywhere = new Set([...named, ...mjsNamesIn(scriptsReadme)]);
  const undocumented = [...onDisk].filter((f) => f !== '_lib.mjs' && !documentedEverywhere.has(f));
  assert.deepEqual(undocumented, [], `scripts/${undocumented.join(', ')} is named in neither SKILL.md nor scripts/README.md`);
});

// ---- the landing gate's item count, compared live, never as a literal ----------------------

function landCheckOrder() {
  const text = readText(join(SCRIPTS_DIR, 'land.mjs'));
  const m = /const CHECK_ORDER = \[([\s\S]*?)\];/.exec(text);
  assert.ok(m, 'land.mjs no longer declares CHECK_ORDER — the gate item list moved somewhere else');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function readmeGateItems() {
  const text = readText(join(SCRIPTS_DIR, 'README.md'));
  const start = text.indexOf('## land.mjs');
  assert.ok(start !== -1, 'scripts/README.md has no "## land.mjs" section');
  const section2 = text.slice(start, text.indexOf('\n### the two guards', start));
  return [...section2.matchAll(/^(\d+)\. ([a-z ]+?)(?: —| \()/gm)].map((x) => x[2].trim());
}

test('scripts/README.md\'s land.mjs item list matches land.mjs\'s own CHECK_ORDER — two live sources, not a hardcoded count', () => {
  const code = landCheckOrder();
  const docs = readmeGateItems();
  assert.equal(docs.length, code.length, `scripts/README.md lists ${docs.length} item(s); land.mjs's CHECK_ORDER has ${code.length}`);
  assert.deepEqual(docs, code, 'the items differ in name or order between land.mjs and its own docs');
});

// ---- reference/roles/ is exactly the ROLES brief.mjs knows ---------------------------------

function briefRoles() {
  const text = readText(join(SCRIPTS_DIR, 'brief.mjs'));
  const m = /const ROLES = \[([^\]]+)\];/.exec(text);
  assert.ok(m, 'brief.mjs no longer declares a ROLES array');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

test('reference/roles/ has exactly the role files named in brief.mjs\'s own ROLES, and no more', () => {
  const fromCode = briefRoles();
  const files = readdirSync(join(SKILL_DIR, 'reference', 'roles'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
  assert.deepEqual(files, fromCode, `reference/roles/ has {${files.join(', ')}}, brief.mjs's ROLES has {${fromCode.join(', ')}}`);
});

// ---- every discipline ROLE_LAW names actually exists ---------------------------------------

function roleLawDisciplines() {
  const text = readText(join(SCRIPTS_DIR, 'brief.mjs'));
  const start = text.indexOf('const ROLE_LAW = {');
  assert.ok(start !== -1, 'brief.mjs no longer declares ROLE_LAW');
  const end = text.indexOf('\n};', start);
  const block = text.slice(start, end);
  const names = new Set();
  // An entry is either a bare string ('tdd') or an object naming one section of a discipline
  // ({ discipline: 'framing', section: 'Checklist' }) — the discipline name is read from each shape
  // separately so a section name (e.g. 'Checklist') is never mistaken for a discipline of its own.
  for (const m of block.matchAll(/discipline:\s*'([^']+)'/g)) names.add(m[1]);
  const withoutObjects = block.replace(/\{[^}]*\}/g, '');
  for (const m of withoutObjects.matchAll(/^\s*(?:worker|architect|legislate|retro):\s*\[([^\]]*)\]/gm)) {
    for (const bare of m[1].matchAll(/'([^']+)'/g)) names.add(bare[1]);
  }
  return names;
}

test('every discipline named in brief.mjs\'s ROLE_LAW exists under reference/discipline/', () => {
  const names = roleLawDisciplines();
  assert.ok(names.size > 0, 'no discipline name could be read out of ROLE_LAW — the parser or the table moved');
  const missing = [...names].filter((n) => !existsSync(join(SKILL_DIR, 'reference', 'discipline', `${n}.md`)));
  assert.deepEqual(missing, [], `ROLE_LAW names a discipline with no file: ${missing.join(', ')}`);
});

// ---- the four plugin manifests and CHANGELOG's top section agree on version ----------------

test('the four plugin manifests carry the same version as CHANGELOG.md\'s top released section', () => {
  const changelog = readText(join(REPO_ROOT, 'CHANGELOG.md'));
  const m = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  assert.ok(m, 'CHANGELOG.md has no top "## [x.y.z]" section');
  const top = m[1];

  const manifests = [
    join(REPO_ROOT, '.claude-plugin', 'plugin.json'),
    join(REPO_ROOT, '.codex-plugin', 'plugin.json'),
    join(REPO_ROOT, '.cursor-plugin', 'plugin.json'),
  ];
  for (const path of manifests) {
    const version = JSON.parse(readFileSync(path, 'utf8')).version;
    assert.equal(version, top, `${path} carries ${version}, CHANGELOG's top section is ${top}`);
  }
  const marketplace = JSON.parse(readFileSync(join(REPO_ROOT, '.github', 'plugin', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.plugins[0].version, top, `.github/plugin/marketplace.json carries ${marketplace.plugins[0].version}, CHANGELOG's top section is ${top}`);
});

// ---- broken states a scan must actually catch ----------------------------------------------

function hasValidFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return false;
  return /^name:\s*\S/m.test(m[1]) && /^description:\s*\S/m.test(m[1]);
}

test('SKILL.md itself has a frontmatter with a name and a description', () => {
  const skill = readText(join(SKILL_DIR, 'SKILL.md'));
  assert.equal(hasValidFrontmatter(skill), true);
});

test('the frontmatter scan actually catches what it is for: no frontmatter, and one missing description', () => {
  assert.equal(hasValidFrontmatter('# horde\n\nno frontmatter here at all.\n'), false);
  assert.equal(hasValidFrontmatter('---\nname: horde\n---\n\n# horde\n'), false, 'a frontmatter with no description is still caught');
  assert.equal(hasValidFrontmatter('---\nname: horde\ndescription: does the thing\n---\n\n# horde\n'), true);
});
