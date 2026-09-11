# The model — how a horde thinks

## Three planes, two loops

```
INTENT     charter · rulings · evidence catalogue          director + the user
   │ "what must become true"                    ▲ escalations, dissents, wave closes
META       the graph: nodes · charters · contracts · rules · log     owners, architect
   │ "how it must be built"                     ▲ drift: code the graph no longer describes
CODE       worktrees · branches · tests · scenarios         workers, verifiers
```

The meta plane is the memory of the organisation, and it is Yggdrasil's:
`.yggdrasil/model/<node>/yg-node.yaml`, aspects with rules, `yg check` (the loop downwards: does the
code respect the graph?), the lock (the loop upwards: is each verdict still bound to the code it
judged?). The horde invents no meta level and keeps no second copy of one; it is the organisation
that keeps both loops closed when the work is too large for one agent. A repository without a graph
gets one at `horde init` — created through `yg`, and where a Grain CLI is available, proposed from
the repository's own code and accepted.

Versioning of the meta plane needs two axes, not one: git for content, and per verdict the hash of
what it judged. A node's charter is current only where the graph still verifies against the code —
which is the question `yg check` answers, and nothing else does.

## The node

A node is a bounded piece of the system — a module, a screen, a package, a cross-cutting concern —
that has:

- a **boundary**: paths, what it exposes, what it depends on;
- a **charter**: why it exists, its constraints, the decisions in force;
- an **owner**: a role leased while work touches the node;
- a **log**: decisions and history — why things are as they are;
- **ports**: what it promises its neighbours, named and described — the port is the contract, one
  object in the graph; there is no version, in the graph or in Horde;
- **evidence**: tests and scenarios that prove it does what it claims.

Why a node and not a team: a team is people who must know each other; a node is context that can be
loaded. An agent has no memory between sessions, but a node has a log. Owners are replaceable; the
context stays.

**Right size.** A node is cut correctly when its charter, its ports and its code fit one Sonnet
context with room to work. Finer costs coordination; coarser overflows context. This is the only
cutting rule. The first cut of a graph is made with the user.

## Roles as functions of the graph

| role | model | kind, and whose | holds | decides | never |
|---|---|---|---|---|---|
| director | Fable or Opus (the user's session) | the top-level session | intent: charter, decision rights, boundary | the escalation list; charter; who audits | reads worker output; merges; dispatches tickets |
| steward | Sonnet, long-lived, one per team branch | teammate of the director — trunk and sub-team alike | queue, journal, handoff, liveness of its team | scheduling, dispatch, mechanical verification, merge on its branch | judgement — escalates; raising a sub-team |
| owner | Sonnet (Opus for a hard node), leased per mission or per wave as the charter says | subagent of its steward | the node's context: charter, contracts, log | the inside of the node; reviews every change in it; proposes tickets | contracts alone; the graph; reviewing its own ticket |
| architect | Opus, cross-cutting, no node | teammate of the director | coherence of the whole graph | approves or vetoes graph changes; files them into Yggdrasil | implementation |
| worker | cheapest capable (Haiku with a checker, Sonnet with a spec) | subagent of its steward | one ticket, one worktree, one branch | implementation detail | contracts, decisions, other branches |
| verifier | never the author; ideally another model; fresh context | subagent of its steward | the evidence | reproducible / not | fixing |
| auditor | Opus, once per wave | subagent of the director | one merged ticket, re-verified as the hub would | a process verdict | — |
| counsel | Opus (Fable only when the user names it) | subagent of the director | one opinion on the director's question | nothing | implementation, scouting |

Only the top-level session creates teammates; a teammate creates subagents, and a subagent answers to
the agent that spawned it and to nobody else. Depth is not configured; it follows the graph. A node
with children and many tickets gets an owner who is a steward for its subtree. The same skill runs one
level down: director : mission :: owner : node.

## Context is the currency

The hierarchy routes context, not authority. Each role has a declared reading set — a filter on the
graph — and reads nothing outside it:

- director: the mission node and its edges, escalations, dissents, wave closes, audit samples;
- steward: its queue, its branch, tickets and their verdicts, the roster of its team;
- owner: its node's subtree, the ports on its boundary, its log;
- worker: the ticket, the node charter, the evidence it must produce;
- verifier: the evidence and the acceptance criteria — never the author's reasoning.

Briefs are rendered by a tool from these sets. Nobody gets the history. A steward is refreshed by
respawn from files. The director reads only what comes up. The hierarchy also routes contact: a brief
names one address, the agent's own parent, and anything meant for someone else travels as a file with
a doorbell to that parent.

## Trust is manufactured in one place

Agents are biased towards their own work, and no prompt fixes that. The structure routes around it:

- author ≠ verifier, always a fresh context, preferably another model;
- evidence over report: a ticket is done when its evidence exists and a verifier reproduced it;
  red-green proof: new tests fail before, pass after;
- contracts are tests: a port names the test that is its promise, so a contract change is a red test
  in the neighbour, which escalates by itself;
- two keys and one approval on every merge: author, verifier, and the owner of every node the ticket
  names (the architect when the owner is the author), recorded on the ticket;
- an Opus auditor redoes one merged ticket per wave in full; the director reads the verdict;
- dissent is a channel, not an argument: an owner may file a dissent against a ruling; it is
  recorded, answered once by whoever made the ruling, and never blocks.

Trust in an agent is a function of the evidence it left in files, not of the reports it sent.

## Flows

1. **Framing** — director and user; charter, node map, decision rights, evidence catalogue, cost
   policy, base branch. Linear, interactive, the only phase with the user in the loop.
2. **Staffing** — steward, owners, architect spawned from rendered briefs; owners refresh charters,
   propose tickets and contracts.
3. **Planning as negotiation** — the steward composes a DAG; disputed contracts escalate with the
   owners' opinions; the architect rules on graph changes; the director rules on the rest. Bounded:
   three rounds, then escalate.
4. **Waves** — the steward dispatches by DAG readiness and cost class; workers in worktrees; owners
   review changes in their nodes; verifiers reproduce evidence; the steward merges with two keys;
   phases overlap.
5. **Wave close** — a cheap post-mortem writes lessons to decisions; the auditor re-verifies a sample;
   the director corrects charter and plan; cost is reported.
6. **Completion** — evidence catalogue green, full gate green on the trunk, audit clean, cost report
   written; the director presents; the user pushes.

## Invariants

- Every change belongs to exactly one ticket; a ticket names one node, or two when it carries a
  contract between them, and then both owners approve.
- Nothing lands without evidence, a second key and the owner's approval.
- Every decision that changes structure is in the graph's log, not in a conversation.
- The truth about who works on what is in files. Liveness is judged by branches and state changes.
- The model class of a task is the cheapest that passes verification, and is written on the ticket.
- The director's context holds intent, escalations, dissents, wave closes and audit samples — nothing else.
- Operational state is uncommitted and dies with the horde; durable knowledge is committed to the
  graph and outlives it.
- Enforcement only ever moves one way on its own. A rule climbs draft → advisory → enforced on
  evidence, without asking, and every climb is written into the graph's log and listed at the wave
  close. Anything that lowers enforcement — a status down, a waiver, a review date, a retirement —
  is the chairman's, under every setting; the horde has no command for it.

## Hard places, named

- Planning can loop: cap rounds, escalate.
- A port change propagates: know who consumes it before it lands (`node.mjs contracts`).
- Cost must be counted even roughly (runs × class), or "cheapest capable" is a wish.
- The first cut of the graph is a judgement the director makes with the user, not alone.
