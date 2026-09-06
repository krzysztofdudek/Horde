# 001 · Retry a failed call three times

**Status:** proposed
**Node:** core · **Class:** sonnet · **Severity:** medium · **Team:** trunk · **Kind:** work
**Depends on:** none · **Branch:** —
**Files:** none
**Consumes:** none · **Produces:** none
**Evidence:** none
**Revert base:** 
**Keys:** author — · verifier — · core —

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

- [ ] node --test src/retry.test.mjs prints 1 pass

## Notes for the worker

Non-obvious context the owner wants the worker to have: where the tricky part is, what not to break,
which contract sits closest.
