# The thing that keeps a promise says the same thing the promise says

You are shown one promise and, beside it, the thing that keeps it — the paired
file, and the modules that file reaches for to do its work.

Read the promise as a claim about the product, sentence by sentence. Then read the
paired material and answer two questions.

**Does every sentence of the promise have cover?** A sentence that asserts
something the product does must correspond to something the paired material
actually exercises. A promise saying an order comes back confirmed *and* the
customer is notified is two claims; material that only ever looks at the
confirmation covers one of them. Say which sentence is uncovered.

**Does the paired material centrally do more than the promise says?** Setup,
fixtures, teardown and the ordinary scaffolding of running something are not
"more" — ignore them. What counts is a second subject: the material asserting
something about the product that the promise never claimed. That is a claim
nobody wrote down, being maintained as though somebody had.

## Which one gives way

**The promise is the truth. Strengthen the evidence; never weaken the promise.**
When the two disagree, the fix is to make the paired material cover what the
promise says. Narrowing the promise so the existing material happens to match it
is the failure this rule exists to catch: it turns a claim about the product into
a description of whatever was built, and there is then nothing left to be wrong.

The one exception is a promise that **cannot be kept at all** — it contradicts
itself, or it claims something the product could not do under any implementation.
That is not a promise to narrow; it is an error to report. Say so plainly, and say
why it cannot be kept.

## What passes

The promise is satisfied when every sentence has cover and the paired material has
no second subject. Scaffolding, helper modules and the mechanics of running things
are never a reason to refuse. Neither is wording: the promise speaks in the
product's words and the material speaks in code, and the question is whether they
are about the same thing, not whether they use the same nouns.

Some paired material arrives incomplete — a note will say so when a module it
reaches for sat outside what this rule is allowed to read, or when the fold was
stopped at a depth or a size. Judge what you were given, and treat what is missing
as unknown rather than as absent cover.
