<img width="1376" height="768" alt="Gemini_Generated_Image_ze518ize518ize51" src="https://github.com/user-attachments/assets/2716dc49-4c76-4106-945a-5fe82068a7cc" />

# Horde

**A mission is too big for one agent's context, so you either watch it lose track of its own earlier decisions, or you split it up yourself and babysit every piece.** Horde does the splitting for you: it turns your coding agent into a director, and the director raises a horde.

```
/plugin marketplace add krzysztofdudek/Horde
/plugin install horde@horde-marketplace
```

Run both, then `/reload-plugins` to activate it in this session (or restart Claude Code). Requires Node.js on your `PATH` (any recent version), since the skill's tools are plain ES modules with zero dependencies. It also needs Yggdrasil, and Claude Code's [Agent Teams](https://code.claude.com/docs/en/agent-teams) turned on, an experimental feature that is off by default; see [Requirements](#requirements) below before you invoke it. Invoke it by handing over a mission: `/horde <mission>`, or your own words for it ("let's run this as a horde").

> MIT licensed · Node scripts, zero dependencies · needs [Yggdrasil](https://github.com/krzysztofdudek/Yggdrasil), and creates the graph if your repository has none · part of the [Yggdrasil family](#the-yggdrasil-family) · [full skill body](skills/horde/SKILL.md)

---

## Requirements

**Yggdrasil.** Horde works on an architecture graph: the map it cuts the work by, the rules every ticket is held to, and the verdict that says a change is safe to merge all come from it. Install it once:

```
npm i -g @chrisdudek/yg
```

Horde 0.2.0 needs a Yggdrasil newer than 5.8.0, the first release that answers with the documents Horde reads the graph through; until it is out, point the horde at a build of Yggdrasil's development branch with `horde.mjs config set ygCommand "node path/to/bin.js"`. An older Yggdrasil is refused with that instruction, never read around.

If your repository already has a graph, Horde reads it. If it doesn't, `horde init` makes one for you before anything else happens. With [Grain](https://github.com/krzysztofdudek/Grain) installed as well, the graph it makes is read out of your own code — the components you actually have and the rules you already follow — and it tells you up front how much of the code you have today those rules would refuse. Without Yggdrasil, Horde stops and says so.

**Claude Code's [Agent Teams](https://code.claude.com/docs/en/agent-teams)**, turned on before you hand over a mission. It's off by default and still experimental. Add this to your `settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Without it, Claude Code never raises a steward that stays alive and addressable for the length of a mission, so the skill has nothing to direct. It also needs an interactive session; headless mode (`-p`) won't spawn a team at all.

Your own session is what raises the long-lived agents — a steward per team and the architect — and everything else runs underneath them as their own helpers, so the number of agents alive alongside you stays small and every one of them is yours to replace.

---

## See it

**The mission: migrate the app's permission system from roles to a policy engine, twelve modules touched.** Alone, an agent either tries to hold all twelve modules in its head and drifts by module nine, or works through them one at a time and forgets what it agreed with itself three files back.

You and Horde write the charter together first: the goal, what's out of scope, and the evidence that proves it's done (tests, scenarios, nothing vaguer than that). Then it cuts the mission into nodes with you, once, and spawns a **steward** and an **architect** who can veto changes to the graph. The steward spawns an **owner** per node. Owners read their node and propose tickets; the steward assembles the proposals into a dependency graph and starts a wave.

Workers pick up tickets, each in its own worktree, each against a locked spec. A **verifier who never verifies its own work** reproduces the evidence before anything merges. Nothing lands without two keys and one approval: the worker's key, the verifier's key, and the owner's review of every node the ticket touches. Once a wave closes, an Opus **auditor** redoes merged tickets from scratch, because a report is a hypothesis until someone who didn't write it reproduces it. How many is a sample size, not a habit: it doubles when an audit catches something, thins out after a long clean run, and never drops to nothing — and every wave close publishes what share of audited work didn't survive the second look, with how confident that share is.

You never read a diff. What comes to you: a contract two owners can't agree on, a claim that something is a boundary and shouldn't be touched, a cost limit reached, anything genuinely unsure. Everything else, the horde rules on itself and writes down why, so the next session picks it up cold from the files, not from your memory of the conversation.

Every line the horde ever merged has a custody chain: point at a file and a line and it tells you the commit that introduced it, the ticket that commit belongs to, who wrote it and who reviewed and verified it, what evidence that ticket was supposed to prove and whether it did, and what the graph currently says about the rules standing over that code. A closed mission is searched too; a line from before the horde ever touched the repository is reported as exactly that.

---

## When it fires

Reach for it when the plan itself doesn't fit in one agent's context with room to work, the actual cutting rule the skill uses for sizing a node. A cross-cutting refactor, a migration, anything where "just have the agent do it" means either a context that overflows or a human babysitting every step.

Say `/horde <mission>`, or hand it over in your own words. A session that resumes an existing horde boots straight into status: what's alive, what's waiting on your ruling, what happens next.

---

## How it thinks

Three planes, two loops:

```
INTENT   charter, rulings, evidence catalogue        you and the director
META     the graph: nodes, charters, contracts       owners, the architect
CODE     worktrees, branches, tests, scenarios        workers, verifiers
```

Roles, and what each one is not allowed to do:

| Role | Model | Decides | Never |
|---|---|---|---|
| Director | your own session | the escalation list, the charter, who audits | reads worker output, merges, dispatches tickets |
| Steward | Sonnet, long-lived | scheduling, dispatch, merging on its branch | judgement, it escalates instead |
| Owner | Sonnet, Opus for a hard node | the inside of its node, proposes tickets | contracts alone, reviewing its own ticket |
| Architect | Opus, no node of its own | approves or vetoes graph changes | implementation |
| Worker | the cheapest model that will pass verification | implementation detail | contracts, decisions, other branches |
| Verifier | never the author, fresh context | reproducible or not | fixing what it finds |
| Auditor | Opus, on a sample per wave | a process verdict on one merged ticket | nothing named |

Every change belongs to exactly one ticket. Liveness is judged by files and branches, never by silence: a steward gone quiet for too long gets reclaimed and respawned from the same charter, not waited for. And it never pushes: starting a mission is your consent to local commits on the horde's own branches, nothing more. The pull request, and the push, stay yours.

---

## Install

### Claude Code plugin (recommended)

Two slash commands. The first registers this repo as a marketplace; the second installs the plugin from it.

```
/plugin marketplace add krzysztofdudek/Horde
/plugin install horde@horde-marketplace
```

Then run `/reload-plugins` to activate it in the current session (or restart Claude Code). Requires Node.js on `PATH` and Claude Code's Agent Teams turned on, see [Requirements](#requirements). No API key.

To upgrade later, refresh the marketplace and reinstall:

```
/plugin marketplace update horde-marketplace
/plugin install horde@horde-marketplace
```

### GitHub Copilot CLI plugin

The same repo is also a [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) marketplace. Register it, then install the plugin:

```
copilot plugin marketplace add krzysztofdudek/Horde
copilot plugin install horde@horde-marketplace
```

To upgrade later: `copilot plugin update horde`.

### Codex CLI plugin

Register this repo as a marketplace, then install:

```
codex plugin marketplace add krzysztofdudek/Horde
codex plugin install horde@horde-marketplace
```

To upgrade later: `codex plugin marketplace upgrade horde-marketplace`. Or drop the whole `skills/horde/` directory into `~/.agents/skills/horde/` (user level) or `.agents/skills/horde/` (project level).

### Cursor plugin

Cursor auto-discovers the skill from the plugin manifest at the repo root. Install it locally:

```
git clone https://github.com/krzysztofdudek/Horde.git
ln -s "$(pwd)/Horde" ~/.cursor/plugins/local/horde
```

Then reload Cursor (**Developer: Reload Window**). Or drop `skills/horde/` into `~/.cursor/skills/horde/` (user level) or `.cursor/skills/horde/` (project level).

### Manual drop-in (any agent that reads markdown skills)

Copy the whole `skills/horde/` directory (`SKILL.md`, `reference/`, `templates/`, `scripts/`) into your agent's skill directory, keeping the structure intact, since `SKILL.md` reads its own `reference/` and `templates/` by relative path.

- **Claude Code, project level:** `.claude/skills/horde/` in your repo
- **Other agents:** wherever your tool reads directory-shaped skills

Nothing else in this repo affects behavior, all of it lives in that one directory.

### The skill's own files, and your graph

Dropping a skill into a repository adds several dozen files to it, and a repository under Yggdrasil
counts every file: the new ones land outside every node's mapping and show up as uncovered, which
drops the coverage figure without anything having gone wrong. Two ways to settle it — map the skill's
directory to a node of its own, if you want the graph to hold your tooling to rules as well, or
exclude it in `yg-config.yaml` if you don't. Either is a deliberate answer; leaving it is a number
that quietly reads worse than the repository deserves.

---

## What it doesn't claim

It's not free. Every spawned agent is a real run on your account, at whatever cost class its ticket carries (Haiku, Sonnet, or Opus for the hard nodes and the rulings). The horde reports cost every wave rather than hiding it, and a charter can carry a cost limit that stops it after the running tickets land.

The multi-agent mechanics run on Claude Code's own Agent Teams, see [Requirements](#requirements). The skill installs the same way on Codex, Cursor, and Copilot, and the discipline travels with it (evidence over reports, escalate rather than guess, nothing merges without two keys), but whether those hosts have anything equivalent to Agent Teams hasn't been checked at all. Try it there and watch whether the spawning holds before trusting it with something you can't easily undo.

It's not a substitute for reading the result. You get the final branch, the evidence catalogue, and the cost report; whether the mission actually did what you meant is still your call, not the auditor's.

---

## FAQ

<details>
<summary><b>Won't this spawn agents endlessly and burn my budget?</b></summary>

No hidden spend: cost is booked once per spawn and summed every wave, and a charter can carry a cost limit that stops the horde after whatever's running lands. Without a limit, nobody asks; the cost still shows up in every wave close, so you're never finding out at the end.
</details>

<details>
<summary><b>Do I have to use Yggdrasil?</b></summary>

Yes, and you don't have to set it up first. Horde works on an architecture graph — that is where the components come from, where the rules over each one come from, and what says a change is safe to merge. On a repository that already has one, Horde reads it and never edits it behind your back. On a repository that doesn't, `horde init` creates the graph, and with Grain installed it reads that first graph out of your own code rather than handing you a blank one. What it will not do is invent a second, weaker map of its own and pretend that is the same thing.
</details>

<details>
<summary><b>What if I'd rather just have one agent do the whole thing?</b></summary>

Then don't reach for this. Horde exists for the case where one agent's context is the actual bottleneck, a mission whose charter, contracts and code genuinely don't fit in one session with room to work. For anything smaller, a single agent with Urd's ask-don't-guess discipline is the right tool, not this one.
</details>

<details>
<summary><b>Why "Horde"?</b></summary>

Not a Norse name, unlike Ratatoskr and Urd. It says what it does: raise many cheap hands under one will, the same plain-word naming Researcher already uses in this family.
</details>

---

## The Yggdrasil family

Four tools, one thesis: **make an AI coding agent prove correctness, stage by stage.** Because "done" isn't done. Each of the first four is a checkpoint at a different point in the pipeline, where the agent has to show its work before it continues.

| Tool | Stage | What it makes the agent prove |
|---|---|---|
| **[Ratatoskr](https://github.com/krzysztofdudek/RatatoskrSkill)** | request → intent | Keeps the agent talking to you in plain words, not code, so you can follow what it's doing. |
| **[Urd](https://github.com/krzysztofdudek/UrdSkill)** | intent → code | When the spec is ambiguous, it consults the source of truth and asks, it doesn't guess. |
| **[Yggdrasil](https://github.com/krzysztofdudek/Yggdrasil)** | code → architecture | Every change satisfies the rules that govern it, checked before the agent moves on. |
| **[Researcher](https://github.com/krzysztofdudek/ResearcherSkill)** | code → measured result | Point it at a metric and it runs experiments, hypotheses kept and discarded. |

Two more sit alongside the chain rather than inside it, and they stack. **[Grain](https://github.com/krzysztofdudek/Grain)** reads a codebase's own code and history and writes the first architecture graph for it, then keeps telling Yggdrasil where practice has drifted from what the graph declares; it needs Yggdrasil and nothing else. **Horde** (this one) sits on top of both: it needs Yggdrasil, uses Grain when it is installed, and is what you add when a mission needs more than one agent to move through all four stages at once, holding every agent it raises to the same standards. Each layer works without the ones above it, and none of them knows the ones above exist.

## Acknowledgements

The law each role carries — tests that can fail, finding the cause before the fix, evidence before
the claim, findings with a severity, framing before anything runs — is modelled on
[obra/superpowers](https://github.com/obra/superpowers) (MIT), by Jesse Vincent, and on its method of
testing a document by the behaviour of the agent that reads it. The wording here is Horde's own, and
the rules travel as role law enforced at the merge rather than as skills of their own.

## License

MIT © [Krzysztof Dudek](https://github.com/krzysztofdudek)

---

<div align="center">
  <img src="yggdrasil.svg" alt="Yggdrasil" width="150" />
</div>
