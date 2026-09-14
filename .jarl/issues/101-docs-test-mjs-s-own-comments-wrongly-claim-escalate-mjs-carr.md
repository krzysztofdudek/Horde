# 101 · docs.test.mjs's own comments wrongly claim escalate.mjs carries a NUL byte composite-key separator

**Status:** done
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** zaplecze
**Files:** skills/horde/scripts/tests/docs.test.mjs
**Found by:** worker 043, reading docs.test.mjs while fixing issue 043
**Where:** skills/horde/scripts/tests/docs.test.mjs, lines ~4 and ~25 (comments explaining the latin1-decode choice)

## What
Two comments in `docs.test.mjs` claim the retired-role and Agent-Teams scans decode files as
latin1 "because escalate.mjs carries a literal NUL byte (its composite-key separator)." Checked
byte-for-byte with Node (`buf.indexOf(0)`): escalate.mjs has zero NUL bytes, in either the working
tree or HEAD. Its actual composite key (see `cmdReview`/the grouping logic) is built with
`JSON.stringify([it.kind, territory, normalized])` — a JSON array string, not a NUL-separated one.

## Why
The comment is confidently wrong about a specific, checkable fact. Whether latin1-decoding is
still the right choice for those scans (e.g. for some other reason — robustness against any
non-utf8 byte in general, not specifically a NUL from escalate.mjs) is a separate question this
issue doesn't answer; the comment's given REASON is false either way and should not stand
uncorrected.

## Acceptance
Either find the real reason latin1-decoding was chosen (check git history/blame on these lines)
and correct the comment to state it accurately, or reword to state the actual, defensible
motivation (e.g. "latin1 never throws on any byte sequence, unlike a strict utf8 decode" — if
that's the real intent) without inventing a specific claim about escalate.mjs. No test needed
beyond the diff — pure comment correction, no behavior change.

## Evidence

- **ran:** git log --all --oneline -S 'NUL byte' -- skills/horde/scripts/tests/docs.test.mjs; node -e "const fs=require('fs'); const b=fs.readFileSync('skills/horde/scripts/escalate.mjs'); console.log('NUL byte index:', b.indexOf(0))" · **saw:** the false NUL-byte claim was wrong from its very first commit (056d95f), never a later drift; NUL byte index: -1, confirming escalate.mjs carries no NUL byte — its real composite key is JSON.stringify([it.kind, territory, normalized])

