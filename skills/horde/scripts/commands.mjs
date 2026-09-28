// horde skill — commands.mjs
//
// The command table: every command of every script in this directory, its arguments and its flags, in one
// place. It is what the MCP server (mcp.mjs) builds its tools from — one tool per command,
// horde_<script>_<command> (horde_tk_log, horde_node_contract_propose; a script with no subcommand is
// horde_<script>: horde_tick, horde_land) — and what the parity tests hold against each script's own
// usage text and against the flags the script's own code reads, so a flag added to a script and
// forgotten here fails a test instead of shipping a tool that cannot say it.
//
// A key is the script's name followed by its command words, exactly as they come after
// `node scripts/<script>.mjs`; the arguments are the positional words after those, in order (`name?`
// may be left out, `name...` takes one or more). A flag is `bool` (bare), `value`, `many` (repeatable),
// `number` or `path` (a file or directory the command resolves against its working directory — over
// MCP it must be absolute). `writes` says whether the command changes anything beyond a disposable
// cache; `destructive` whether it can remove what is there.
//
// Not in the table, on purpose: audit.mjs and loop.mjs (imported by other scripts, no command line of
// their own), vendor.mjs and runes.mjs (this repository's own vendoring gates, run by its tests and CI,
// never by a mission), and handoff.mjs's retired write, add-waiting and rm-waiting (they only refuse).
// Nothing else is left out.

// Flags every command takes. `help` is the CLI's own and never a tool field.
export const GLOBAL_FLAGS = { json: 'bool', horde: 'value', help: 'bool' };

// The tree a command reads the graph from, where the command lets its caller choose.
const TREE = { tree: 'path' };
// node.mjs's three ways to name that tree: a worktree, a ticket's own worktree, a throwaway one at a sha.
const NODE_TREE = { tree: 'path', ticket: 'value', scratch: 'value' };
const BRIEF = { name: 'value', tree: 'path', out: 'path' };

export const COMMANDS = {
  // ask.mjs — questions to the client
  'ask add': { args: ['why'], flags: { kind: 'value', ticket: 'value', territory: 'value', aspect: 'value' }, writes: true, summary: 'Files a question to the client (kind stop, stuck, lower or charter).' },
  'ask list': { flags: { open: 'bool' }, summary: 'Lists the questions to the client, open first.' },
  'ask show': { args: ['id'], summary: 'Shows one question to the client.' },
  'ask answer': { args: ['id', 'answer'], flags: { scope: 'value' }, writes: true, summary: "Records the client's answer to a question and closes it." },

  // blame.mjs
  blame: { args: ['location'], flags: { ...TREE }, summary: 'Traces <file>:<line> to the ticket that landed it, with its evidence and the verdicts on its component.' },

  // brief.mjs — the brief each role is spawned with
  'brief architect': { flags: { ...BRIEF }, writes: true, summary: "Renders the architect's brief (or writes it to out)." },
  'brief worker': { args: ['ticket'], flags: { ...BRIEF, takeover: 'bool' }, writes: true, summary: "Renders a ticket's worker brief (or writes it to out)." },
  'brief legislate': { args: ['territory'], flags: { ...BRIEF }, writes: true, summary: "Renders one territory's legislate brief (or writes it to out)." },
  'brief retro': { flags: { ...BRIEF }, writes: true, summary: "Renders the retrospective's brief (or writes it to out)." },
  'brief review': { args: ['ticket'], flags: { ...BRIEF }, writes: true, summary: "Renders a ticket's one-shot review brief (or writes it to out)." },

  // decide.mjs — the mission's rulings
  'decide add': { args: ['slug', 'ruling'], flags: { ticket: 'value', node: 'value', by: 'value', supersedes: 'value' }, writes: true, summary: "Appends a ruling to the mission's record." },
  'decide list': { flags: { grep: 'value', node: 'value' }, summary: 'Lists the rulings, newest first.' },
  'decide show': { args: ['slug'], summary: 'Shows one ruling in full.' },

  // drill.mjs — the disciplines' drills
  'drill list': { flags: { corpus: 'path' }, summary: 'Lists the disciplines, their drills and the recorded cases.' },
  'drill check': { args: ['drill'], flags: { repo: 'path', ticket: 'value' }, summary: "Asserts a drill against a repository's real state." },
  'drill run': { args: ['drill'], flags: { corpus: 'path', yg: 'value' }, summary: 'Runs every recorded case of a drill and checks each comes out as recorded.' },
  'drill record': { args: ['name'], flags: { discipline: 'value', expect: 'value', ticket: 'value', corpus: 'path', note: 'value' }, writes: true, summary: 'Records the current state as a new drill case.' },

  // escalate.mjs
  'escalate recurring': { flags: { min: 'number' }, summary: 'Groups the answers the client keeps giving and proposes each recurring one as a rule.' },

  // handoff.mjs
  'handoff read': { summary: 'The state a session resumes the mission from, read live from its loop.' },

  // horde.mjs — hordes
  'horde init': { args: ['name'], flags: { base: 'value', title: 'value', 'test-globs': 'value', nodes: 'value', yg: 'value', grain: 'value', quality: 'value' }, writes: true, summary: 'Opens a horde: the graph when there is none, the charter, the loop and the trunk branch.' },
  'horde list': { summary: 'Lists the hordes on this repository.' },
  'horde config get': { args: ['key'], summary: 'Reads one key of .horde/config.json.' },
  'horde config set': { args: ['key', 'value'], writes: true, summary: 'Sets one key of .horde/config.json.' },
  'horde charter show': { summary: 'Prints the mission charter.' },
  'horde charter edit': { flags: { ask: 'value', from: 'path' }, writes: true, destructive: true, summary: 'Replaces the mission charter with the text of the file from names.' },
  'horde archive': { args: ['name'], writes: true, destructive: true, summary: 'Archives a horde and releases its node leases.' },
  'horde history': { summary: 'Every closed mission on this repository, newest first.' },
  'horde done': { flags: { ...TREE }, writes: true, summary: "The mission's final gate: refuses with every reason, or stamps the charter and archives the horde." },

  // land.mjs — the landing gate
  land: { args: ['tickets'], flags: { level: 'value', 'no-gate': 'bool', background: 'bool', tree: 'path', fate: 'value', by: 'value' }, writes: true, summary: "Lands tickets through the nine-item gate and merges them when every item is green, or records a landed ticket's fate." },

  // law.mjs
  'law diff': { flags: { wave: 'number' }, writes: true, summary: 'Writes what the law has gained this mission (horde-law/1) and prints its path.' },

  // node.mjs — the graph, its leases, ports and proposals
  'node bind': { args: ['node?'], flags: { ...NODE_TREE, take: 'bool', ask: 'value' }, writes: true, summary: 'Leases a node to this horde, or with no node lists every node id.' },
  'node map': { flags: { ...NODE_TREE }, summary: "This mission's nodes with their ports and open port proposals." },
  'node show': { args: ['node'], flags: { ...NODE_TREE }, summary: "A node's boundary, rules in force, ports and last log entries." },
  'node log': { args: ['node', 'reason'], flags: { ...NODE_TREE, run: 'bool' }, writes: true, summary: 'Prints the yg log add command for a node, and runs it with run.' },
  'node contract propose': { args: ['node', 'port', 'text'], flags: { ...NODE_TREE, by: 'value', aspects: 'value' }, writes: true, summary: 'Proposes adding or changing a port of a node.' },
  'node contract approve': { args: ['id', 'why?'], flags: { ...NODE_TREE, by: 'value' }, writes: true, summary: 'The architect approves a port proposal.' },
  'node contract veto': { args: ['id', 'why?'], flags: { ...NODE_TREE, by: 'value' }, writes: true, summary: 'The architect vetoes a port proposal.' },
  'node contracts': { flags: { ...NODE_TREE, pending: 'bool', node: 'value' }, summary: "The ports of this mission's nodes and the open port proposals." },
  'node propose': { args: ['kind', 'text'], flags: { ...NODE_TREE, by: 'value', node: 'value', boundary: 'value' }, writes: true, summary: 'Proposes a graph change (new-node, move-boundary, rename or rule).' },
  'node proposals': { flags: { ...NODE_TREE, open: 'bool' }, summary: 'Lists the graph-change proposals.' },
  'node approve': { args: ['id', 'why?'], flags: { ...NODE_TREE, by: 'value' }, writes: true, summary: 'The architect approves a graph-change proposal.' },
  'node veto': { args: ['id', 'why?'], flags: { ...NODE_TREE, by: 'value' }, writes: true, summary: 'The architect vetoes a graph-change proposal.' },
  'node apply': { args: ['id'], flags: { ...NODE_TREE }, writes: true, summary: 'Closes an approved graph-change proposal and prints its filing steps.' },
  'node ladder': { flags: { ...NODE_TREE }, summary: 'Every rule with its rung, drill cases, refusals and waves seen clean.' },
  'node promote': { args: ['aspect'], flags: { ...NODE_TREE, by: 'value', node: 'value', 'with-reviewer': 'bool' }, writes: true, summary: 'Raises a rule one rung on its own evidence.' },
  'node demote': { args: ['aspect'], flags: { ...NODE_TREE, to: 'value', by: 'value', why: 'value', node: 'value' }, writes: true, summary: "Lowers a rule, on the user's word only." },

  // queue.mjs — the schedule
  'queue list': { flags: { state: 'value', team: 'value' }, summary: 'Lists the queue.' },
  'queue add': { args: ['ticket'], flags: { depends: 'value', proposed: 'bool', ask: 'value', team: 'value' }, writes: true, summary: 'Adds a ticket to the queue.' },
  'queue set': { args: ['ticket', 'state'], flags: { sha: 'value', agent: 'value', note: 'value', adopt: 'bool', on: 'value', team: 'value' }, writes: true, summary: "Moves a queue item to a state (running cuts its branch and worktree, merged removes them)." },
  'queue dep': { args: ['ticket'], flags: { on: 'value', team: 'value' }, writes: true, summary: 'Adds a dependency to a queue item.' },
  'queue undep': { args: ['ticket'], flags: { on: 'value', note: 'value', team: 'value' }, writes: true, summary: 'Takes a dependency off a queue item or ticket.' },
  'queue regate': { args: ['ticket'], flags: { note: 'value', team: 'value' }, writes: true, summary: "Sets a ticket's last red gate aside so the next tick asks the gate again." },
  'queue next': { flags: { class: 'value', why: 'bool', stack: 'bool', team: 'value' }, summary: 'The first ready queued item.' },
  'queue plan': { flags: { team: 'value', 'apply-order': 'bool', out: 'path', tree: 'path' }, writes: true, summary: "The team's plan (layers, critical path, file clashes, uncovered evidence); writes only with apply-order or out." },
  'queue quality': { flags: { from: 'path', class: 'value', 'dry-run': 'bool', all: 'bool', team: 'value', tree: 'path' }, writes: true, summary: 'Files one quality ticket per improvement a grain-advice/1 document names.' },
  'queue rm': { args: ['ticket'], flags: { team: 'value' }, writes: true, destructive: true, summary: 'Removes a queue item.' },
  'queue render': { flags: { team: 'value' }, writes: true, summary: "Rewrites the queue's rendered view." },
  'queue reconcile': { flags: { reclaim: 'value', team: 'value' }, writes: true, summary: 'Settles every running item whose worker has ended.' },

  // refine.mjs
  refine: { flags: { step: 'value', team: 'value', tree: 'path', out: 'path' }, writes: true, summary: 'Refining, one step at a time: cut, consult, review or frame.' },

  // report.mjs
  report: { flags: { out: 'path', 'no-measure': 'bool' }, writes: true, summary: "Writes the client's plain-language report now, with Grain's before-and-after reading of the territory unless no-measure." },

  // retro.mjs
  retro: { flags: { ...TREE }, writes: true, summary: "The mission's retrospective: gathers its input, or writes the document once the one-shot has classified it." },

  // status.mjs
  status: { flags: { team: 'value' }, summary: 'One screen: every horde, its trunk, queue, open asks, last gate and leases.' },

  // tick.mjs — the loop
  tick: { flags: { runner: 'value', watch: 'bool', stack: 'bool', reclaim: 'value', tree: 'path' }, writes: true, summary: 'One run of the loop: reconcile, put ready branches through the gate, and list what to start now.' },

  // tk.mjs — tickets
  'tk new': { args: ['slug'], flags: { title: 'value', node: 'many', class: 'value', severity: 'value', kind: 'value', 'no-quality': 'bool', depends: 'value', files: 'value', 'boundary-proposal': 'value', consumes: 'value', produces: 'value', evidence: 'many', 'revert-base': 'value', mutate: 'value', reopens: 'value', reverts: 'value', tree: 'path', team: 'value' }, writes: true, summary: 'Files a ticket.' },
  'tk list': { flags: { state: 'value', node: 'value', open: 'bool', team: 'value' }, summary: 'Lists the tickets.' },
  'tk show': { args: ['ticket'], flags: { log: 'bool' }, summary: 'Shows a ticket, and its log with log.' },
  'tk status': { args: ['ticket', 'state', 'note?'], writes: true, summary: "Sets a ticket's status (changes counts a fix round)." },
  'tk log': { args: ['ticket', 'text'], writes: true, summary: "Appends a line to a ticket's log." },
  'tk grep': { args: ['regex'], summary: 'Searches every ticket.' },
  'tk accept': { args: ['ticket'], flags: { sha256: 'value', by: 'value' }, writes: true, summary: "Records the client's acceptance of a prototype." },
  'tk review-close': { args: ['ticket'], flags: { by: 'value' }, writes: true, summary: "Writes a review's closing line, counting its findings." },
  'tk review-skip': { args: ['ticket', 'reason'], flags: { by: 'value' }, writes: true, summary: "The director's call that a raised review will not close." },
  'tk edit': { args: ['ticket'], flags: { by: 'value', files: 'value', 'boundary-proposal': 'value', consumes: 'value', produces: 'value', evidence: 'many', depends: 'value', from: 'path', tree: 'path' }, writes: true, summary: "Rewrites a ticket's body from the file from names, or changes its fields." },
  'tk move': { args: ['ticket'], flags: { team: 'value' }, writes: true, summary: 'Moves a ticket to another team.' },

  // wave.mjs — waves
  'wave start': { args: ['n?'], flags: { team: 'value', tree: 'path' }, writes: true, summary: 'Opens a wave.' },
  'wave note': { args: ['text'], flags: { team: 'value' }, writes: true, summary: "Appends a dated note to the wave's journal." },
  'wave merged': { args: ['ticket', 'sha'], flags: { team: 'value' }, writes: true, summary: 'Records a merge the queue never saw.' },
  'wave close': { flags: { gate: 'value', sha: 'value', evidence: 'value', team: 'value' }, writes: true, summary: 'Closes the wave: its report, the quality block and the law audit.' },
  'wave evidence': { args: ['id'], flags: { ask: 'value', artifact: 'value', run: 'value' }, writes: true, summary: "Fills one evidence row's reproduced-by cell from something this tool checks." },
  'wave current': { flags: { team: 'value' }, summary: 'The open wave number, or none.' },
};

// The script a command key runs: its first word.
export const scriptOf = (command) => command.split(' ')[0];
// Every script the table covers, in the order it first appears.
export const SCRIPTS = [...new Set(Object.keys(COMMANDS).map(scriptOf))];

// The commands that may run long — a gate, a reviewer, Grain mining a repository — and the time the
// MCP server allows each of them; every other command gets the default.
export const LONG_RUNNING = new Set(['land', 'tick', 'horde done', 'horde init', 'wave close', 'wave evidence', 'drill run', 'drill check', 'drill record', 'node promote', 'queue quality', 'retro']);
