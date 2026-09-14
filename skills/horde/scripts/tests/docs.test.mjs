// The documentation's own shape, read off disk — modelled on the deleted brief-paths.test.mjs's
// idiom: these tests read files and compare what they say against each other or against the code,
// never render a brief or run a tool. The one scan that walks arbitrary files (the retired-role
// scan, below) decodes as latin1 rather than utf8: latin1 maps every byte value to a character and
// never throws, so a stray non-UTF-8 byte anywhere in the scanned set can't make the scan crash or
// silently skip a file the way a strict UTF-8 decode would; every other test here reads a named
// file as real utf8 text instead, since it has to compare actual prose (em dashes, checkmarks), not
// just look for an ASCII substring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRepo, rmRepo, run, initHorde, addNode,
} from './helpers.mjs';

const SKILL_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const REPO_ROOT = join(SKILL_DIR, '..', '..');
const SCRIPTS_DIR = join(SKILL_DIR, 'scripts');

// latin1: never throws on any byte sequence, unlike a strict utf8 decode — used only for the
// retired-role-name scan below, which only ever looks for plain ASCII words and does not care that
// a multi-byte UTF-8 character elsewhere decodes to mangled bytes under it.
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
const RETIRED_ROLE_RE = /\b(stewards?|owners?|verifiers?|auditors?|counsels?)\b/i;

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

// ---- the scripts README names a retired role only where it is naming history -----------------

// scripts/README.md is the tool set's own contract, and the half-removed seat model left the old
// role names scattered through it — describing live commands as if a steward, an owner or a
// verifier still ran them. The words are not banned outright here: the readers kept so a mission
// started before 6.0.0 (and every archive of one) still opens HAVE to name the seats they read
// for. They are confined to one section, so the contract reads in one model and the compatibility
// surface is a list somebody can actually check rather than a scatter nobody can find.
const SCRIPTS_HISTORY_HEADING = '## pre-6.0.0 history';

// The text with one `## ` section cut out of it — from its heading to the next `## ` heading, so
// the exemption ends where the section does and never spills into whatever follows it.
function withoutSection(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return text;
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return text.slice(0, start) + (next === -1 ? '' : rest.slice(next));
}

function retiredRolesOutside(text, heading) {
  const offenders = [];
  for (const line of withoutSection(text, heading).split('\n')) {
    const m = RETIRED_ROLE_RE.exec(line);
    if (m) offenders.push(`names "${m[1]}": ${line.trim()}`);
  }
  return offenders;
}

test('scripts/README.md names a retired role only inside its "pre-6.0.0 history" section', () => {
  const text = readRaw(join(SCRIPTS_DIR, 'README.md'));
  assert.ok(
    text.includes(SCRIPTS_HISTORY_HEADING),
    `scripts/README.md has no "${SCRIPTS_HISTORY_HEADING}" section — the readers kept for a pre-6.0.0 mission have nowhere to be named`,
  );
  const offenders = retiredRolesOutside(text, SCRIPTS_HISTORY_HEADING);
  assert.deepEqual(offenders, [], `retired role named outside the history section:\n${offenders.join('\n')}`);
});

test('the scripts-README scan actually catches what it is for: a retired role outside the section, and one after it', () => {
  const clean = '# scripts\n\nA worker lands its own branch.\n\n## pre-6.0.0 history\n\nThe steward, the owner and the verifier are gone.\n';
  assert.deepEqual(retiredRolesOutside(clean, SCRIPTS_HISTORY_HEADING), []);

  const before = '# scripts\n\nAn owner files the ticket.\n\n## pre-6.0.0 history\n\nThe steward is gone.\n';
  assert.ok(
    retiredRolesOutside(before, SCRIPTS_HISTORY_HEADING).some((o) => o.includes('owner')),
    'a retired role named before the history section should be caught',
  );

  const after = '# scripts\n\n## pre-6.0.0 history\n\nThe steward is gone.\n\n## land.mjs\n\nThe verifier signs it off.\n';
  assert.ok(
    retiredRolesOutside(after, SCRIPTS_HISTORY_HEADING).some((o) => o.includes('verifier')),
    'the exemption must end at the next "## " heading, not run to the end of the file',
  );

  const plural = '# scripts\n\nWhat owners use to write ticket bodies.\n\n## pre-6.0.0 history\n\nGone.\n';
  assert.ok(
    retiredRolesOutside(plural, SCRIPTS_HISTORY_HEADING).some((o) => o.includes('owners')),
    'the plural of a retired role should be caught too',
  );
});

// ---- the model page replaces topology.md ---------------------------------------------------

test('reference/topology.md no longer exists, and reference/model.md carries Mechanics and Runner', () => {
  assert.equal(existsSync(join(SKILL_DIR, 'reference', 'topology.md')), false);
  const model = readText(join(SKILL_DIR, 'reference', 'model.md'));
  assert.match(model, /^## Mechanics$/m);
  assert.match(model, /^## Runner$/m);
});

// ---- the test-environment boundary: supplied from outside, Horde never builds it (issue 032) --

// A boundary no document names gets crossed sooner or later — here, by a worker who finds a thin
// or missing test environment and tries to "fix" it. The sentence has to say all of it: the
// environment is supplied from outside Horde, Horde only ever works with what it finds, and never
// builds one itself — in both SKILL.md and model.md. The charter's own Evidence section carries the
// same boundary, since that is the one paragraph a worker reads to learn what the mission's proof
// rests on: what the mission found, never what Horde built to get there.
const SUPPLIED_OUTSIDE_RE = /supplied\s+from\s+outside\s+Horde/i;
const NEVER_BUILDS_RE = /\bnever\s+builds\b/i;

test('SKILL.md and reference/model.md both say the test environment is supplied from outside Horde and Horde never builds it', () => {
  const skill = readText(join(SKILL_DIR, 'SKILL.md'));
  const model = readText(join(SKILL_DIR, 'reference', 'model.md'));
  for (const [name, text] of [['SKILL.md', skill], ['reference/model.md', model]]) {
    assert.match(text, SUPPLIED_OUTSIDE_RE, `${name} does not say the test environment is supplied from outside Horde`);
    assert.match(text, NEVER_BUILDS_RE, `${name} does not say Horde never builds the test environment`);
  }
});

test('SKILL.md ties the boundary to the split that keeps a worker from closing the gap itself: charter records what it found, frame reports what is missing', () => {
  const skill = readText(join(SKILL_DIR, 'SKILL.md'));
  const evidenceLayer = section(skill, '## Recognising the evidence layer');
  assert.match(evidenceLayer, SUPPLIED_OUTSIDE_RE, 'the evidence-layer section does not name the environment boundary');
  assert.match(evidenceLayer, /\bcharter\b/i, 'the evidence-layer section does not tie the boundary to the charter');
  assert.match(evidenceLayer, /\bframe\b/i, 'the evidence-layer section does not tie the boundary to the frame');
});

test('templates/charter.md\'s Evidence section says it records what the mission found, never what Horde built', () => {
  const charter = readText(join(SKILL_DIR, 'templates', 'charter.md'));
  const evidence = section(charter, '## Evidence in this repository');
  assert.match(evidence, SUPPLIED_OUTSIDE_RE, 'charter.md\'s Evidence section does not name the environment boundary');
  assert.match(evidence, NEVER_BUILDS_RE, 'charter.md\'s Evidence section does not say Horde never builds the environment');
});

// ---- no file names Agent Teams, and no file says "teammate" ---------------------------------

// The skill runs on plain subagents and nothing else: there is no runner built on Claude Code's
// Agent Teams, and the word "teammate" means exactly one thing in Claude Code — an agent of that
// feature — so leaving it in the prose would keep the concept alive under a new label. The ban is
// scoped to what a person or an agent actually reads to learn how this works, plus the adopter
// register's unreleased section. Two exclusions, both deliberate: tests/** (this file names the
// banned strings, and tests/drills/ is a fixture corpus of old prose, the same idiom the
// retired-role scan above uses), and every released CHANGELOG section — history is not rewritten.
const AGENT_TEAMS_RES = [
  /Agent Teams/,
  /agent-teams/i,
  /\bteammates?\b/i,
  /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/,
];

function unreleasedSection(changelog) {
  const start = changelog.indexOf('## [Unreleased]');
  assert.notEqual(start, -1, 'CHANGELOG has no "## [Unreleased]" heading');
  const rest = changelog.slice(start + '## [Unreleased]'.length);
  const next = rest.search(/^## \[/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('nothing the skill, the repo docs or the unreleased changelog says names Agent Teams or a teammate', () => {
  const scanned = [
    [join(REPO_ROOT, 'CLAUDE.md'), readRaw(join(REPO_ROOT, 'CLAUDE.md'))],
    [join(REPO_ROOT, 'README.md'), readRaw(join(REPO_ROOT, 'README.md'))],
    [join(SKILL_DIR, 'SKILL.md'), readRaw(join(SKILL_DIR, 'SKILL.md'))],
    ...walk(join(SKILL_DIR, 'reference')).map((f) => [f, readRaw(f)]),
    ...walk(join(SKILL_DIR, 'templates')).map((f) => [f, readRaw(f)]),
    ...readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs'))
      .map((f) => [join(SCRIPTS_DIR, f), readRaw(join(SCRIPTS_DIR, f))]),
    [join(SCRIPTS_DIR, 'README.md'), readRaw(join(SCRIPTS_DIR, 'README.md'))],
    ['CHANGELOG.md [Unreleased]', unreleasedSection(readRaw(join(REPO_ROOT, 'CHANGELOG.md')))],
  ];
  assert.ok(scanned.length > 20, `expected the whole skill tree, scanned ${scanned.length} file(s)`);

  const offenders = [];
  for (const [label, text] of scanned) {
    for (const re of AGENT_TEAMS_RES) {
      const m = re.exec(text);
      if (m) offenders.push(`${label}: names "${m[0]}"`);
    }
  }
  assert.deepEqual(offenders, [], `Agent Teams are gone from Horde; still named in:\n${offenders.join('\n')}`);
});

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

test('CLAUDE.md points at the model page for the runner, and states no runner as a requirement', () => {
  const claude = readText(join(REPO_ROOT, 'CLAUDE.md'));
  assert.match(claude, /reference\/model\.md`?, \*\*Runner\*\* section/, 'CLAUDE.md should still point at the canonical runner statement');
  assert.doesNotMatch(claude, /mechanics depend on/i);
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

// ---- every *.mjs named anywhere in the docs exists in scripts/ (the other direction) -------

// The check above only ever verified SKILL.md's own names against disk; scripts/README.md's names
// were collected solely to mark a script "documented" and never checked to exist themselves. That
// gap is exactly how scripts/README.md and escalate.mjs's own header comment both went on naming
// `legislate.mjs` — a script that has never existed on disk ("legislate" is a brief.mjs role,
// rendered from reference/roles/legislate.md, not a standalone script) — with nothing to catch it.
// This walks every doc a person or an agent reads to learn the tool set and checks the reverse
// direction there too.
//
// Three tokens mjsNamesIn's regex correctly extracts from that prose but that are not scripts/
// files, so they are excluded by name rather than chased:
//   - check.mjs, companion.mjs — the generic Yggdrasil per-rule file names
//     (.yggdrasil/aspects/<id>/check.mjs), a naming convention from outside this tool set, named
//     in prose about what a rule's own directory holds (reference/roles/legislate.md, retro.md;
//     scripts/README.md's law-guard section).
//   - test.mjs — not a name at all: the tail of a glob the regex reads on its own, e.g.
//     `*.test.mjs` or `family.e2e.test.mjs` in scripts/README.md's own Tests section.
const NOT_A_SCRIPT_NAME = new Set(['check.mjs', 'companion.mjs', 'test.mjs']);

function docFiles() {
  return [
    join(SKILL_DIR, 'SKILL.md'),
    ...walk(join(SKILL_DIR, 'reference')),
    ...walk(join(SKILL_DIR, 'templates')),
    join(SCRIPTS_DIR, 'README.md'),
    join(REPO_ROOT, 'README.md'),
    join(REPO_ROOT, 'CLAUDE.md'),
  ];
}

test('every *.mjs named in the docs (SKILL.md, reference/**, templates/**, scripts/README.md, README.md, CLAUDE.md) exists in scripts/', () => {
  const files = docFiles();
  assert.ok(files.length > 15, `expected the whole doc surface, found ${files.length} file(s)`);
  const onDisk = new Set(readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')));

  const offenders = [];
  for (const file of files) {
    for (const name of mjsNamesIn(readText(file))) {
      if (!onDisk.has(name) && !NOT_A_SCRIPT_NAME.has(name)) offenders.push(`${file}: names "${name}"`);
    }
  }
  assert.deepEqual(offenders, [], `a doc names a script that does not exist:\n${offenders.join('\n')}`);
});

test('the docs\' *.mjs scan actually catches a script that does not exist, and does not false-positive on check.mjs/companion.mjs/test.mjs', () => {
  const onDisk = new Set(readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')));
  const sample = mjsNamesIn('see `legislate.mjs`, `check.mjs`, `companion.mjs` and `*.test.mjs`');
  const offenders = [...sample].filter((n) => !onDisk.has(n) && !NOT_A_SCRIPT_NAME.has(n));
  assert.deepEqual(offenders, ['legislate.mjs'], 'the scan should flag only the name that is neither a real script nor in the known-non-script allowlist');
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

// ---- worker brief scopes test runs to the touched file(s), in the foreground, with a timeout --

test('reference/roles/worker.md tells the worker to run only the touched test file(s), in the foreground, with an explicit timeout, and leaves the full suite to landing', () => {
  const worker = readText(join(SKILL_DIR, 'reference', 'roles', 'worker.md'));
  const prove = section(worker, '**Prove it red-green.**', /^- \*\*/m);
  assert.match(prove, /\bforeground\b/i, 'worker.md does not say to run tests in the foreground');
  assert.match(prove, /timeout/i, 'worker.md does not mention setting the shell tool\'s timeout explicitly');
  assert.match(prove, /\btest file\(s\)|touch(?:es|ed)? test file/i,
    'worker.md does not scope the run to the test file(s) the change touches');
  assert.match(prove, /\bnever\b.*\b(whole|full)\b.*(gate|suite)|(landing|merger).*\bjob\b/i,
    'worker.md does not say the whole gate/suite is landing\'s job, not the worker\'s');
});

// ---- who spawns under each runner: docs must match tick.mjs's own code ----------------------

// tick.mjs's externalStart() is the one place any of this script's own code calls spawnProcess,
// and it only runs when runner === 'external' (see runOnce). So the code's own truth is: under
// `session`, tick.mjs spawns nothing; under `external`, tick.mjs spawns each worker itself. Three
// prose spots claim to state that same fact — tick.mjs's own header, model.md's Runner section,
// and scripts/README.md — and this test checks each one asserts it, not the stale "tick never
// spawns" blanket claim that ignored the external runner entirely.
test('tick.mjs, model.md and README all describe who spawns under each runner, matching the code', () => {
  const tickSrc = readText(join(SCRIPTS_DIR, 'tick.mjs'));
  const modelSrc = readText(join(SKILL_DIR, 'reference', 'model.md'));
  const readmeSrc = readText(join(SCRIPTS_DIR, 'README.md'));

  // The code fact: spawnProcess is called only inside externalStart, gated on runner === 'external'.
  assert.match(tickSrc, /function externalStart\(/);
  assert.match(tickSrc, /spawnProcess\(/);
  assert.match(tickSrc, /runner === 'external' \? externalStart\(/);

  const files = [['tick.mjs', tickSrc], ['model.md', modelSrc], ['README.md', readmeSrc]];

  // No file may still carry the old blanket claim that tick never spawns under either runner.
  for (const [name, src] of files) {
    assert.ok(!/spawns nothing under either/.test(src),
      `${name} still claims tick.mjs spawns nothing under either runner`);
  }

  // Each file must say plainly that under `session` tick never spawns (the caller does).
  for (const [name, src] of files) {
    assert.match(src, /session.{0,40}tick never spawns|tick never spawns.{0,80}session/is,
      `${name} does not say tick never spawns under session`);
  }

  // Each file must say plainly that under `external` tick.mjs spawns each worker itself.
  for (const [name, src] of files) {
    assert.match(src, /external.{0,200}spawns each worker itself|spawns each worker itself.{0,200}external/is,
      `${name} does not say tick.mjs itself spawns each worker under external`);
  }
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

// ---- queue.mjs plan's --out flag is documented in scripts/README.md ------------------------

test('scripts/README.md\'s plan bullet documents queue.mjs plan\'s --out flag', () => {
  const readme = readText(join(SCRIPTS_DIR, 'README.md'));
  const start = readme.indexOf('- `plan [--team t]');
  assert.ok(start !== -1, 'scripts/README.md has no `plan` bullet under queue.mjs');
  const rest = readme.slice(start);
  const next = rest.search(/\n- `/);
  const bullet = next === -1 ? rest : rest.slice(0, next);

  const signature = /^- `(plan[^`]*)`/.exec(bullet);
  assert.ok(signature, 'the plan bullet does not open with a `plan ...` usage signature');
  assert.match(signature[1], /--out/, `the plan bullet's usage signature "${signature[1]}" omits --out`);
  assert.match(bullet, /to a file instead of stdout/i, 'the plan bullet never explains that --out writes the plan to a file instead of stdout');
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

// ---- reference/roles/ never invokes an escalate.mjs subcommand that does not exist ----------

// escalate.mjs's whole command surface is one subcommand, `recurring` — read live off its own
// switch statement rather than hardcoded, so a future subcommand added there does not need this
// test touched. A role brief that tells an agent to run `escalate.mjs <anything else>` is telling
// it to run a command that fails outright.
function escalateCommands() {
  const text = readText(join(SCRIPTS_DIR, 'escalate.mjs'));
  const names = [...text.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'no case label could be read out of escalate.mjs\'s dispatch — the switch moved');
  return new Set(names);
}

test('reference/roles/ invokes escalate.mjs only with a subcommand escalate.mjs actually has', () => {
  const known = escalateCommands();
  const files = walk(join(SKILL_DIR, 'reference', 'roles'));
  assert.ok(files.length > 0, 'expected a real reference/roles/ tree');
  const offenders = [];
  for (const file of files) {
    const text = readText(file);
    for (const m of text.matchAll(/escalate\.mjs\s+([a-zA-Z]+)/g)) {
      if (!known.has(m[1])) offenders.push(`${file}: "escalate.mjs ${m[1]}" — escalate.mjs has no such command (only: ${[...known].join(', ')})`);
    }
  }
  assert.deepEqual(offenders, [], `escalate.mjs invoked with a nonexistent subcommand:\n${offenders.join('\n')}`);
});

test('the frontmatter scan actually catches what it is for: no frontmatter, and one missing description', () => {
  assert.equal(hasValidFrontmatter('# horde\n\nno frontmatter here at all.\n'), false);
  assert.equal(hasValidFrontmatter('---\nname: horde\n---\n\n# horde\n'), false, 'a frontmatter with no description is still caught');
  assert.equal(hasValidFrontmatter('---\nname: horde\ndescription: does the thing\n---\n\n# horde\n'), true);
});

// ---- the change-request syntax reference/discipline/review.md shows actually runs ----------

// review.md's own code block is not prose about a command — it is the command an agent reading
// the discipline literally pastes into a shell (a legislate or retro brief carries the whole file
// verbatim under "## Law"). Parsed and executed here against a real ticket, standing in for the
// general docs-vs-USAGE scan below (issue 016): this was the one case it would have caught —
// `tk.mjs review` was removed and review.md kept calling it.
function reviewMdCommands() {
  const text = readText(join(SKILL_DIR, 'reference', 'discipline', 'review.md'));
  const m = /and the ticket goes back:\n\n```\n([\s\S]*?)```/.exec(text);
  assert.ok(m, 'review.md no longer has a fenced command block after "and the ticket goes back:"');
  const joined = m[1].replace(/\\\n\s*/g, ' ').trim();
  const prefix = '${CLAUDE_PLUGIN_ROOT:-.claude/skills/horde}/scripts/';
  return joined.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    assert.ok(line.startsWith(`node ${prefix}`), `unexpected command line in review.md: ${line}`);
    const rest = line.slice(`node ${prefix}`.length);
    // A minimal tokenizer for the doc's own shape: bare words, or one "double-quoted" argument.
    const tokens = [];
    const re = /"([^"]*)"|(\S+)/g;
    let t;
    while ((t = re.exec(rest)) !== null) tokens.push(t[1] !== undefined ? t[1] : t[2]);
    return tokens;
  });
}

test('reference/discipline/review.md\'s change-request commands run against a real ticket', () => {
  const commands = reviewMdCommands();
  assert.ok(commands.length >= 2, 'expected the log line and the status transition');

  const dir = makeRepo();
  try {
    initHorde(dir, 'mission1');
    addNode(dir, 'core', { mapping: ['src/**'] });
    execFileSync('git', ['checkout', '-q', 'mission1/trunk'], { cwd: dir });
    execFileSync('git', ['add', '.yggdrasil'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=test@test.com', '-c', 'user.name=Test User', 'commit', '-qm', 'graph'], { cwd: dir });

    const created = run('tk.mjs', ['new', 'retry', '--title', 'Retry a failed call', '--node', 'core', '--class', 'standard',
      '--evidence', 'node --test src/retry.test.mjs prints 1 pass'], dir);
    assert.equal(created.code, 0, created.stderr);
    const id = created.json.id;

    const placeholders = {
      NNN: id,
      '<node>': 'core',
      '<your name>': 'reviewer1',
      '<file:line>': 'src/retry.mjs:5',
      '<what is wrong>': 'the retry count is off by one',
      '<why it matters>': 'the last attempt never runs',
      '<one-line summary>': 'sent back for a Critical finding',
    };
    const substitute = (arg) => Object.entries(placeholders).reduce((s, [k, v]) => s.split(k).join(v), arg);

    for (const [tool, ...args] of commands) {
      const r = run(tool, args.map(substitute), dir);
      assert.equal(r.code, 0, `${tool} ${args.join(' ')} failed: ${r.stderr}`);
    }

    const drill = run('drill.mjs', ['check', 'review', '--repo', dir, '--ticket', id], dir);
    assert.equal(drill.code, 0, drill.stdout + drill.stderr);
    assert.equal(drill.json.ok, true);
  } finally {
    rmRepo(dir);
  }
});

// ---- every brief.mjs example carries every flag USAGE marks required ------------------------
//
// brief.mjs's own USAGE line is the one source of which flags a role invocation cannot omit: a
// flag outside "[...]" is required, one inside is optional. Read off USAGE directly rather than
// hardcoding "--name" here, so a future required flag is caught by this test without editing it.
// A doc example that shows a role invocation without a flag USAGE marks required would make a
// director's very first copied command refuse — this is exactly the failure 044 found.

function briefRequiredFlags() {
  const text = readText(join(SCRIPTS_DIR, 'brief.mjs'));
  const m = /usage: brief\.mjs <role> ([^`\n]+)/.exec(text);
  assert.ok(m, 'brief.mjs no longer has a recognizable "usage: brief.mjs <role> ..." USAGE line');
  const rest = m[1];
  // required flags: a "--flag" token that is not inside a "[...]" optional group
  const withoutOptional = rest.replace(/\[[^\]]*\]/g, '');
  return [...withoutOptional.matchAll(/--([a-z-]+)/g)].map((x) => x[1]);
}

// Extracts every text run that shows brief.mjs invoked with a real role name (not a placeholder
// like "<role>") — inline `code spans` (which may wrap across a markdown line break), lines
// inside fenced ``` code blocks, and "double-quoted" runs (how a .mjs source comment writes a
// worked example, e.g. tk.mjs's own fix-round comments) — as the unit a reader would copy
// verbatim.
function briefInvocationSnippets(text) {
  const rolePattern = '(?:architect|worker|legislate|retro)';
  const snippets = [];
  for (const m of text.matchAll(/`([^`]+)`/gs)) {
    if (new RegExp(`brief\\.mjs\\s+${rolePattern}\\b`).test(m[1])) snippets.push(m[1]);
  }
  for (const m of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of m[1].split('\n')) {
      if (new RegExp(`brief\\.mjs\\s+${rolePattern}\\b`).test(line)) snippets.push(line);
    }
  }
  for (const m of text.matchAll(/"([^"]+)"/g)) {
    if (new RegExp(`brief\\.mjs\\s+${rolePattern}\\b`).test(m[1])) snippets.push(m[1]);
  }
  return snippets;
}

test('brief.mjs invocation examples in SKILL.md, scripts/README.md and tk.mjs carry every flag USAGE requires', () => {
  const required = briefRequiredFlags();
  assert.ok(required.includes('name'), 'USAGE no longer requires --name — this test\'s premise moved');

  const files = [
    join(SKILL_DIR, 'SKILL.md'),
    join(SCRIPTS_DIR, 'README.md'),
    join(SCRIPTS_DIR, 'tk.mjs'),
  ];
  const failures = [];
  for (const path of files) {
    const text = readText(path);
    for (const snippet of briefInvocationSnippets(text)) {
      for (const flag of required) {
        if (!new RegExp(`--${flag}\\b`).test(snippet)) {
          failures.push(`${path}: "${snippet.trim()}" is missing --${flag}`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the brief.mjs example scan actually catches what it is for: an example missing a required flag', () => {
  const text = 'Spawn a worker (`brief.mjs worker NNN`), one ticket each.';
  const snippets = briefInvocationSnippets(text);
  assert.deepEqual(snippets, ['brief.mjs worker NNN']);
});

// ---- the product-language aspect's description names every category the code refuses -------

// check.mjs's CATEGORIES table is the one source of what this rule refuses (its own header
// comment says so). The aspect's description is the one sentence an adopter reads as the rule's
// contract, so every distinct label in the table needs a word or phrase in that sentence that a
// reader can map back to it — the way "a path" plainly covers "a file path". This test reads both
// live off disk rather than hardcoding the category list, so a category added to check.mjs without
// a matching word added to the description fails here instead of only in a reader's confusion.
function productLanguageCategoryLabels() {
  const text = readText(join(REPO_ROOT, 'packages', 'promises', 'product-language', 'check.mjs'));
  const m = /export const CATEGORIES = \[([\s\S]*?)\n\];/.exec(text);
  assert.ok(m, 'check.mjs no longer declares CATEGORIES the way this test expects');
  return [...new Set([...m[1].matchAll(/label: '([^']+)'/g)].map((x) => x[1]))];
}

test('product-language\'s yg-aspect.yaml description names every category label check.mjs refuses', () => {
  const labels = productLanguageCategoryLabels();
  assert.ok(labels.length >= 8, `expected at least 8 distinct category labels, found ${labels.length}`);
  assert.ok(labels.includes('a table name') && labels.includes('a field name'),
    'this test\'s premise moved: check.mjs no longer labels table-name/field-name as expected');

  const yaml = readText(join(REPO_ROOT, 'packages', 'promises', 'product-language', 'yg-aspect.yaml'));
  const descriptionLine = /^description: (.+)$/m.exec(yaml);
  assert.ok(descriptionLine, 'yg-aspect.yaml has no description: line');
  const description = descriptionLine[1].toLowerCase();

  // Each label's core noun (its last word, singular) must appear somewhere in the description —
  // a coarse but honest proxy for "a reader can map this label back to a clause of the sentence".
  const missing = [];
  for (const label of labels) {
    const noun = label.split(/\s+/).pop().toLowerCase();
    if (!description.includes(noun)) missing.push(label);
  }
  assert.deepEqual(missing, [], `description names no word for: ${missing.join(', ')}\ndescription: "${descriptionLine[1]}"`);
});

// ---- issue 063: CHANGELOG's version note matches node.mjs's actual floor, never a major ceiling -

// node.mjs checks the graph's machine documents by schema name (`parsed.schema === schema`), never
// by comparing version numbers — YG_DOCUMENTS_AFTER names only the floor a refusal message points
// an adopter at. Read live rather than hardcoded, so a future floor bump is caught here too.
function ygDocumentsAfter() {
  const text = readText(join(SCRIPTS_DIR, 'node.mjs'));
  const m = /const YG_DOCUMENTS_AFTER = '([\d.]+)';/.exec(text);
  assert.ok(m, 'node.mjs no longer declares YG_DOCUMENTS_AFTER the way this test expects');
  return m[1];
}

function topChangelogSection(changelog) {
  const start = changelog.search(/^## \[\d+\.\d+\.\d+\]/m);
  assert.ok(start !== -1, 'CHANGELOG.md has no top "## [x.y.z]" section');
  const rest = changelog.slice(start);
  const next = rest.slice(1).search(/^## \[/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('CHANGELOG\'s top released section states the Yggdrasil floor as "<version> or newer", never a same-major ceiling', () => {
  const floor = ygDocumentsAfter();
  const topSection = topChangelogSection(readText(join(REPO_ROOT, 'CHANGELOG.md')));

  assert.match(topSection, new RegExp(`Yggdrasil ${floor.replace(/\./g, '\\.')} or newer`),
    `top released section does not state the Yggdrasil floor as "${floor} or newer", matching node.mjs's own YG_DOCUMENTS_AFTER`);
  assert.doesNotMatch(topSection, /\bsame major\b/i,
    'top released section claims a same-major-only gate — node.mjs checks the documents\' schema name, '
    + 'not a version-number comparison, so a newer major keeps working');
});

// ---- issue 016: every documented <script>.mjs command/flag exists in that script's own USAGE --

// Issue 001 and issue 002 were one class of bug: a doc line invoking a subcommand or flag the
// script had already dropped. This closes the class instead of the one case: it extracts every
// `<script>.mjs <subcommand> ... --flag` shown across SKILL.md, scripts/README.md and reference/**
// (the same three places a director or a role brief copies a command line from), and checks each
// piece against the named script's own live USAGE text — never a second, hand-maintained list.

const DOC_SCRIPT_NAMES = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4));

function scriptUsage(name) {
  const text = readText(join(SCRIPTS_DIR, `${name}.mjs`));
  const m = /const USAGE = `([\s\S]*?)`;/.exec(text);
  return m ? m[1] : '';
}

// Subcommand names: the one word right after "usage: <script>.mjs " on the USAGE's own first
// line (when it isn't a placeholder), plus every "  <word> ..." line under a "commands:" section
// — the two shapes every USAGE in scripts/ actually uses.
function usageCommands(usage) {
  const names = new Set();
  const head = /^usage: [a-zA-Z.]+\.mjs\s+(\S+)/.exec(usage);
  if (head && !/^[<[-]/.test(head[1])) names.add(head[1].replace(/[.,]$/, ''));
  const cmdSection = /commands:\n([\s\S]*?)\n\noptions:/.exec(usage);
  if (cmdSection) {
    for (const m of cmdSection[1].matchAll(/^ {2}([a-zA-Z-]+)/gm)) names.add(m[1]);
  }
  return names;
}

// One doc invocation per `<script>.mjs` mention, confined to one line (a backtick span or a
// fenced code line never crosses a newline in these docs) so a code example and unrelated prose
// two lines later are never joined into one match.
function docInvocations(text) {
  const out = [];
  for (const m of text.matchAll(/\b([a-zA-Z_-]+)\.mjs\b([^\n`]*)/g)) {
    if (!DOC_SCRIPT_NAMES.includes(m[1])) continue;
    out.push({ script: m[1], rest: m[2] });
  }
  return out;
}

// Scoped this way on purpose: a subcommand is only checked on an invocation that also carries a
// flag (real command syntax, per the issue's own "<skrypt>.mjs <podkomenda> --flag" shape) — a
// bare word like "`wave.mjs audit`" used as a noun in prose ("no audit verdict was recorded") is
// not this test's business and belongs to whichever issue is about that sentence, not this one.
function docOffenders(docFiles) {
  const offenders = [];
  for (const file of docFiles) {
    const text = readText(file);
    for (const { script, rest } of docInvocations(text)) {
      const usage = scriptUsage(script);
      if (!usage) continue;
      const commands = usageCommands(usage);
      const firstToken = (rest.trim().split(/\s+/)[0] || '').replace(/[.,:]+$/, '');
      const hasFlag = /--[a-z-]/.test(rest);
      if (hasFlag && firstToken && /^[a-zA-Z-]+$/.test(firstToken) && commands.size > 0
          && !commands.has(firstToken)) {
        offenders.push(`${file}: "${script}.mjs ${firstToken}" — no such command (known: ${[...commands].join(', ')})`);
      }
      for (const flagM of rest.matchAll(/--([a-z-]+)/g)) {
        if (!usage.includes(`--${flagM[1]}`)) {
          offenders.push(`${file}: "${script}.mjs" uses --${flagM[1]}, absent from its own USAGE`);
        }
      }
    }
  }
  return offenders;
}

test('the doc-vs-USAGE scan actually catches dead syntax: a dropped command and a dropped flag', () => {
  const scratch = join(SCRIPTS_DIR, 'tests', '.tmp-docs-scan-fixture.md');
  const assertCatches = (body, expectSubstr) => {
    writeFileSync(scratch, body);
    const found = docOffenders([scratch]);
    unlinkSync(scratch);
    assert.ok(found.some((o) => o.includes(expectSubstr)), `expected an offender mentioning "${expectSubstr}", got:\n${found.join('\n')}`);
  };
  assertCatches('Run `escalate.mjs sweep --horde h` after every wave.', 'no such command');
  assertCatches('Run `escalate.mjs recurring --min 2 --dry-run --horde h` after every wave.', 'uses --dry-run');

  writeFileSync(scratch, 'Run `escalate.mjs recurring --min 2 --horde h` after every wave.');
  const clean = docOffenders([scratch]);
  unlinkSync(scratch);
  assert.deepEqual(clean, [], `a real command/flag pair should not be flagged, got:\n${clean.join('\n')}`);
});

test('every documented <script>.mjs subcommand and flag exists in that script\'s own USAGE', () => {
  const docFiles = [
    join(SKILL_DIR, 'SKILL.md'),
    join(SCRIPTS_DIR, 'README.md'),
    ...walk(join(SKILL_DIR, 'reference')),
  ];
  const offenders = docOffenders(docFiles);
  assert.deepEqual(offenders, [], `dead doc syntax:\n${offenders.join('\n')}`);
});

// ---- issue 057: README's propose entry names --node/--boundary, and that move-boundary
// requires them, matching node.mjs's own USAGE ------------------------------------------------

// The doc-vs-USAGE scan above (issue 016) only catches a flag that appears in the docs but not in
// USAGE. It does not catch the opposite gap this issue is about: a flag USAGE marks required for
// one kind of `propose`, silently missing from README's own syntax line entirely. node.mjs's own
// USAGE is the one source of which flags `propose` takes and which kind requires them — read live
// off the propose command's own block rather than hardcoded, so a future change to what
// move-boundary requires is caught here too, instead of leaving README to say nothing about it
// again.
function proposeUsageBlock() {
  const usage = scriptUsage('node');
  const m = /^ {2}propose <kind>.*(?:\n {4,}.*)*/m.exec(usage);
  assert.ok(m, 'node.mjs USAGE no longer has a `propose <kind>` command line');
  return m[0];
}

function requiredFlagNames(text) {
  const m = /requires ([^.]+)/.exec(text);
  assert.ok(m, `no "requires ..." clause found in: ${text}`);
  return [...m[1].matchAll(/--([a-z-]+)/g)].map((x) => x[1]);
}

test('scripts/README.md\'s propose entry names --node/--boundary and says move-boundary requires them', () => {
  const required = requiredFlagNames(proposeUsageBlock());
  assert.deepEqual(required, ['node', 'boundary'],
    'node.mjs USAGE no longer requires exactly --node and --boundary for move-boundary — this test\'s premise moved');

  const readme = readText(join(SCRIPTS_DIR, 'README.md'));
  const bulletM = /^- `propose <kind>[\s\S]*?(?=\n- )/m.exec(readme);
  assert.ok(bulletM, 'scripts/README.md has no `propose <kind>` bullet');
  const bullet = bulletM[0];

  for (const flag of required) {
    assert.match(bullet, new RegExp(`--${flag}\\b`), `README's propose entry does not mention --${flag}`);
  }
  assert.match(bullet, /move-boundary[\s\S]{0,120}requires/,
    'README\'s propose entry does not say move-boundary requires anything');
});

// ---- issue 060: wave.mjs's own README section names only commands wave.mjs's USAGE has --------

// The general doc-vs-USAGE scan above only flags a "script.mjs subcommand --flag" phrase written
// together on one line; wave.mjs's own README section instead opens with a bare list of
// backtick-quoted commands ("`start [n] [--team t]`, `note "…"`, … `audit-plan [--seed <n>]
// [--team t]`, …") with no repeated "wave.mjs" prefix on each one, so that scan never sees it.
// `audit` and `audit-plan` were deleted from wave.mjs by the seat-cassation migration (2c8ed09,
// "Audit sampling … is gone from both a wave's close and a mission's done check") but survived
// in this opening list. Read both sides live: wave.mjs's own USAGE commands, and every backtick
// span in the section's opening paragraph that has the shape of a command definition (a bare,
// optionally hyphenated word followed by a space, "[", a quote, or the end of the span) — the
// shape every real command here takes, and no file path, flag or `module.mjs` mention does.
function commandLikeSpans(text) {
  return [...text.matchAll(/`([^`]+)`/g)]
    .map((m) => /^([a-z]+(?:-[a-z]+)*)(?=[\s["]|$)/.exec(m[1]))
    .filter(Boolean)
    .map((m) => m[1]);
}

test('scripts/README.md\'s wave.mjs command list names only commands wave.mjs\'s own USAGE has', () => {
  const usage = scriptUsage('wave');
  assert.ok(usage, 'wave.mjs no longer has a recognizable USAGE block');
  const known = usageCommands(usage);
  assert.ok(known.size > 0, 'no command could be read out of wave.mjs\'s own USAGE');

  const readme = readText(join(SCRIPTS_DIR, 'README.md'));
  const waveSection = section(readme, '## wave.mjs — the journal').trim();
  const opening = waveSection.split('\n\n')[0];
  const named = [...new Set(commandLikeSpans(opening))];
  assert.ok(named.includes('start') && named.includes('close'),
    'this test\'s premise moved: the opening paragraph no longer lists start/close');

  const offenders = named.filter((n) => !known.has(n));
  assert.deepEqual(offenders, [], `scripts/README.md names wave.mjs command(s) absent from its own USAGE: ${offenders.join(', ')} (USAGE has: ${[...known].join(', ')})`);
});

// ---- constants and where they come from (issue 013) ----------------------------------------
//
// A threshold has provenance, not a signature: issue 013 found nine numbers with no recorded
// origin (a measurement, a transport ceiling, a client's decision) and one, `max_bytes`, that
// already has one and is the pattern the rest follow. Every value below is read live off the
// source that actually defines it — never retyped as a literal here — so a row goes stale the
// moment the code and the table disagree, exactly like `landCheckOrder()`/`readmeGateItems()`
// above hold land.mjs's own gate list to its docs.

function defaultConfigSlice() {
  const text = readText(join(SCRIPTS_DIR, 'horde.mjs'));
  const start = text.indexOf('function defaultConfig(root) {');
  assert.ok(start !== -1, 'horde.mjs no longer declares defaultConfig(root)');
  const end = text.indexOf('\n// ---- the graph', start);
  assert.ok(end !== -1, 'could not find the end of defaultConfig() — its own closing marker moved');
  return text.slice(start, end);
}

function constantsTable() {
  const readme = readText(join(SCRIPTS_DIR, 'README.md'));
  const heading = '## Constants and where they come from';
  const start = readme.indexOf(heading);
  assert.ok(start !== -1, `scripts/README.md has no "${heading}" section`);
  const rest = readme.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function tableRows() {
  return constantsTable().split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .filter((l) => !/^\s*\|\s*-+\s*\|/.test(l))
    .filter((l) => !/^\s*\|\s*Constant\s*\|/.test(l));
}

// Each [key, value] pair: `key` is the exact substring the table's own row is expected to carry
// (never guessed — every value comes from a regex read against the real file), `value` the
// current live default. A key that stops matching means the source it names moved; a value that
// stops matching means the table fell out of step with the code.
function liveConstants() {
  const cfg = defaultConfigSlice();
  const node = readText(join(SCRIPTS_DIR, 'node.mjs'));
  const escalate = readText(join(SCRIPTS_DIR, 'escalate.mjs'));
  const promises = readText(join(REPO_ROOT, 'packages', 'promises', 'yg-package.yaml'));

  const need = (re, text, label) => {
    const m = re.exec(text);
    assert.ok(m, `could not read ${label} off its own source — the pattern that finds it moved`);
    return m[1];
  };

  return [
    ['parallelism', need(/parallelism:\s*(\d+)/, cfg, 'parallelism')],
    ['fixRounds.resume', need(/fixRounds:\s*\{\s*resume:\s*(\d+)/, cfg, 'fixRounds.resume')],
    ['fixRounds.fresh', need(/fixRounds:\s*\{\s*resume:\s*\d+,\s*fresh:\s*(\d+)/, cfg, 'fixRounds.fresh')],
    ['tick.interval', need(/tick:\s*\{\s*interval:\s*(\d+)/, cfg, 'tick.interval')],
    ['territory.maxBytes', need(/territory:\s*\{\s*maxBytes:\s*(\d+)/, cfg, 'territory.maxBytes')],
    ['law.retireAfterWaves', need(/law:\s*\{\s*retireAfterWaves:\s*(\d+)/, cfg, 'law.retireAfterWaves')],
    ['law.qualityDropAsk', need(/law:\s*\{\s*retireAfterWaves:\s*\d+,\s*qualityDropAsk:\s*([\d.]+)/, cfg, 'law.qualityDropAsk')],
    ['WAVES_CLEAN_FOR_ENFORCED', need(/const WAVES_CLEAN_FOR_ENFORCED = (\d+);/, node, 'WAVES_CLEAN_FOR_ENFORCED')],
    ['escalate.mjs recurring --min', need(/flags\.min === undefined \? (\d+) :/, escalate, "escalate.mjs's --min default")],
    ['max_bytes', need(/max_bytes:\s*\n\s*type: number\s*\n\s*default:\s*(\d+)/, promises, "promises' max_bytes")],
  ];
}

test('every constant issue 013 found has a row in scripts/README.md\'s constants table, with its current value', () => {
  const rows = tableRows();
  assert.ok(rows.length >= 10, `expected at least 10 data rows in the constants table, found ${rows.length}`);

  const constants = liveConstants();
  assert.equal(new Set(constants.map(([k]) => k)).size, constants.length, 'two constants share the same lookup key');

  for (const [key, value] of constants) {
    const matches = rows.filter((r) => r.includes(key));
    assert.equal(matches.length, 1, `expected exactly one row naming ${key}, found ${matches.length}`);
    assert.ok(matches[0].includes(String(value)), `the row for ${key} does not carry its current value (${value}):\n${matches[0]}`);
  }
});
