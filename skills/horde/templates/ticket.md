# {{id}} · {{title}}

**Status:** {{status}}
**Node:** {{node}} · **Class:** {{class}} · **Severity:** {{severity}} · **Team:** {{team}} · **Kind:** {{kind}} · **Quality:** {{quality | autonomous}}
**Depends on:** {{dependsOn | none}} · **Branch:** {{branch}}
**Files:** {{files | none}}
**Consumes:** {{consumes | none}} · **Produces:** {{produces | none}}
**Evidence:** {{evidence | none}}
**Revert base:** {{revertBase | }}

## What

One paragraph: the change, in product language where a person could see it, in code language where
only code sees it.

## Why

The line of the charter or the evidence catalogue this serves, or the finding that raised it.

## Scope

What is in. What is explicitly out. The **Files:** field above is the binding list — the merge
checklist refuses a diff that reaches past it, and widening it is `tk.mjs edit NNN --files …`.

## Acceptance — evidence

Each line is something a verifier reproduces without talking to the author:

- [ ] …

## Notes for the worker

Non-obvious context the owner wants the worker to have: where the tricky part is, what not to break,
which contract sits closest.
