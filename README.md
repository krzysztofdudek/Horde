<img width="1376" height="768" alt="Gemini_Generated_Image_ze518ize518ize51" src="https://github.com/user-attachments/assets/2716dc49-4c76-4106-945a-5fe82068a7cc" />

# Horde

**A mission is too big for one agent's context, so you either watch it lose track of its own earlier decisions, or you split it up yourself and babysit every piece.** Horde does the splitting for you: it turns your coding agent into a director, and the director raises a horde.

[![ci](https://github.com/krzysztofdudek/Horde/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Horde/actions/workflows/ci.yml)

```
/plugin marketplace add krzysztofdudek/Horde
/plugin install horde@horde-marketplace
```

Run both, then `/reload-plugins` to activate it in this session (or restart Claude Code). Requires Node.js on your `PATH` (any recent version), since the skill's tools are plain ES modules with zero dependencies, and Yggdrasil; see [Requirements](#requirements) below before you invoke it. Invoke it by handing over a mission: `/horde <mission>`, or your own words for it ("let's run this as a horde").

> MIT licensed · Node scripts, zero dependencies · needs [Yggdrasil](https://github.com/krzysztofdudek/Yggdrasil), and creates the graph if your repository has none · part of the [Yggdrasil family](#the-yggdrasil-family) · [full skill body](skills/horde/SKILL.md)

---

## Requirements

Two things, and only two.

**Node.js on your `PATH`** (any recent version). The skill's tools are plain ES modules with zero dependencies.

**Yggdrasil**, the same 6.x line as this release of Horde. Horde works on an architecture graph: the map it cuts the work by, the rules every ticket is held to, and the verdict that says a change is safe to merge all come from it. Install it once:

```
npm i -g @chrisdudek/yg
```

An older Yggdrasil — one that predates the versioned documents Horde reads the graph through — is refused with the release to install, never read around.

If your repository already has a graph, Horde reads it. If it doesn't, `horde init` makes one for you before anything else happens. With [Grain](https://github.com/krzysztofdudek/Grain) installed as well, the graph it makes is read out of your own code — the components you actually have and the rules you already follow — and it tells you up front how much of the code you have today those rules would refuse. Without Yggdrasil, Horde stops and says so.

That's it.

---

## See it

**The mission: migrate the app's permission system from roles to a policy engine, twelve modules touched.** Alone, an agent either tries to hold all twelve modules in its head and drifts by module nine, or works through them one at a time and forgets what it agreed with itself three files back.

You and Horde write the charter together first: the goal, what's out of scope, and the evidence that proves it's done (tests, scenarios, nothing vaguer than that). Then it cuts the mission into territories — sets of whole components, sized so one agent can hold one and still have room to work — and spawns one **consultant** per territory, all at once. Each reads its own area and nothing else, and writes the tickets and the law it thinks the work has earned. Nothing any of them writes is dispatched yet: an **architect** rules the whole plan once, before anything starts — what's missing, what's buildable, what's circular, what's grown too big to be one piece.

Workers pick up tickets, each in its own worktree, each against a locked spec. Nothing merges by hand: a nine-item checklist runs fresh on the branch itself, and the moment every item is green it makes the merge commit and moves on — new tests proven to fail without the change, the architecture rules read and satisfied, the diff kept inside what the ticket declared. After a wave, a **legislate** pass reads what that area's own work was refused for and writes the pattern down as a rule, so the next ticket in that area gets it enforced rather than repeated by hand.

You never read a diff. What comes to you: a worker that ran out of spec and stopped rather than guess, a request to weaken a rule, a cost limit reached, a change to the mission card itself. Everything else, the horde rules on itself and writes down why, so the next session picks it up cold from the files, not from your memory of the conversation. At the very end, a **retrospective** reads everything nobody read twice — every refusal, every note a worker left the next one — and sorts it into what the law could have said, what's worth one line in a component's own history, and what no rule will ever capture; that last list is yours to read, because it's the one thing the horde cannot learn on its own.

Every line the horde ever merged has a custody chain: point at a file and a line and it tells you the commit that introduced it, the ticket that commit belongs to, who wrote it and what the merge checklist proved before it was let through, what evidence that ticket was supposed to prove and whether it did, and what the graph currently says about the rules standing over that code. A closed mission is searched too; a line from before the horde ever touched the repository is reported as exactly that.

---

## When it fires

Reach for it when the plan itself doesn't fit in one agent's context with room to work, the actual cutting rule the skill uses for sizing a node. A cross-cutting refactor, a migration, anything where "just have the agent do it" means either a context that overflows or a human babysitting every step.

Say `/horde <mission>`, or hand it over in your own words. A session that resumes an existing horde boots straight into status: what's alive, what's waiting on your ruling, what happens next.

---

## How it thinks

Three planes, two loops:

```
INTENT   charter, evidence catalogue, asks           you and the director
META     the graph: nodes, ports, contracts, rules   the architect, consultants, legislate
CODE     worktrees, branches, tests, scenarios       workers
```

Three functions carry the work, plus a one-shot review of the whole plan and the one client in the
loop:

| Function | Model | Decides | Never |
|---|---|---|---|
| Director | your own session | what to ask the client, the charter, build decisions between tickets | reads worker output, merges, dispatches tickets by hand |
| Consultation | the territory's own class, one per territory | what a territory's own tickets and law should be | the boundary between territories |
| Work | the cheapest model that will pass the merge checklist | implementation detail, one ticket at a time | contracts, decisions, other branches |
| Legislation | the territory's own class, once per territory per wave | which pattern the code has already earned as a rule | lowering a rule |
| Architect (one-shot) | Opus, no node of its own | approves or vetoes graph changes, rules the whole plan once | implementation |
| Client | you | the mission, every answered ask, whether it ships | reviewing every diff |

Every change belongs to exactly one ticket. Liveness is judged by files and branches, never by silence. And it never pushes: starting a mission is your consent to local commits on the horde's own branches, nothing more. The pull request, and the push, stay yours.

---

## Install

### Claude Code plugin (recommended)

Two slash commands. The first registers this repo as a marketplace; the second installs the plugin from it.

```
/plugin marketplace add krzysztofdudek/Horde
/plugin install horde@horde-marketplace
```

Then run `/reload-plugins` to activate it in the current session (or restart Claude Code). Requires Node.js on `PATH` and Yggdrasil, see [Requirements](#requirements). No API key.

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

The default runner is your own session: your turn calls the loop, reads what it says to dispatch, and spawns the workers. The loop can also be driven from outside any agent — a cron job or a script of your own, pointed at how your tools start an agent — and then that is what starts each worker instead; nothing about the loop itself changes either way, only who starts what it hands out. The skill installs the same way on Codex, Cursor, and Copilot, and the discipline travels with it (evidence over reports, ask rather than guess, nothing merges without a green checklist), but whether those hosts spawn agents the way this one leans on hasn't been checked at all. Try it there and watch whether the spawning holds before trusting it with something you can't easily undo.

It's not a substitute for reading the result. You get the final branch, the evidence catalogue, and the cost report; whether the mission actually did what you meant is still your call.

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

Then don't reach for this — but you don't need a separate tool to make that call. Horde is the one door: hand it any mission and it runs the same charter-first loop whether that mission turns out to need one worker or twelve. A mission whose charter, contracts and code fit in one session with room to work moves through Horde as a single ticket, no ceremony beyond the charter itself.
</details>

<details>
<summary><b>Why "Horde"?</b></summary>

Not a Norse name, unlike Ratatoskr and Urd. It says what it does: raise many cheap hands under one will, the same plain-word naming Researcher already uses in this family.
</details>

---

## The Yggdrasil family

**Three jobs, one core, in layers.** **[Yggdrasil](https://github.com/krzysztofdudek/Yggdrasil)** is the law: the architecture graph and the rails that hold every change to it. **[Grain](https://github.com/krzysztofdudek/Grain)** surveys the terrain: it mines that graph from a repository's own code and history, so there is a rule-backed map before anyone writes a rule by hand. **Horde** is the software house that builds on the law: zero standing roles, a worker per ticket and a one-shot architect who rules the whole plan once, each ticket refined onto the graph and given a tick. Adoption runs Grain first — install it day zero for a soft, draft-only law that never blocks — then Yggdrasil as the core you keep long term, hard law with proof and CI; Horde is the one door for any mission too big for one agent, not a second path that only opens once a lone agent runs out of room. From 6.0.0 the core ships as one version; the add-ons keep their own. In the family, law is raised by whichever agent does the work in its own territory, and only the client — the one person the whole system answers to — lowers or vetoes it. The three repositories' shared machine contracts are registered on [one page](https://krzysztofdudek.github.io/Yggdrasil/family-contracts).

| Core | What it holds |
|---|---|
| **[Yggdrasil](https://github.com/krzysztofdudek/Yggdrasil)** | The law. The architecture graph and the rails that hold every change to it, checked before the agent moves on, re-proved in CI without a key. |
| **[Grain](https://github.com/krzysztofdudek/Grain)** | The terrain survey. Mines a repository's own code and history into a first graph — components, dependencies, and the rules the code already keeps, each with the count of places that break it today; Yggdrasil accepts it with one command. |
| **Horde** (this one) | The software house on the law. Zero standing roles: a worker per ticket in its own worktree, refined onto the graph and given a tick by a nine-item merge checklist; a one-shot architect rules the whole plan once; the client orders the mission and is the only one who can lower or veto a rule. |

Three add-ons attach to the agent rather than to the graph, and each works alone. Horde doesn't assume any of them is installed — it carries its own minimum discipline in each role's law — but uses them when they are, one sentence per row below.

| Add-on | Stage | What it makes the agent prove | In Horde's loop |
|---|---|---|---|
| **[Ratatoskr](https://github.com/krzysztofdudek/RatatoskrSkill)** | request → intent | Keeps the agent talking to you in plain words, not code, so you can follow what it's doing. | Keeps the client's plain-language registry open at both ends of a mission. |
| **[Urd](https://github.com/krzysztofdudek/UrdSkill)** | intent → code | When the spec is ambiguous, it consults the source of truth and asks, it doesn't guess. | The stop a worker hits before it guesses. |
| **[Researcher](https://github.com/krzysztofdudek/ResearcherSkill)** | code → measured result | Point it at a metric and it runs experiments, hypotheses kept and discarded. | Runs the retrospective's measurement. |

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
