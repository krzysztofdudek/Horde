# Node · {{node}}

**Owner:** {{owner}} ({{class}}) · **Lease:** {{lease}}

## Why it exists

Two or three sentences a newcomer needs before touching anything here.

## Boundary

Paths inside; what it exposes; what it depends on. This mirrors the component's own `yg-node.yaml`
and must not contradict it — the graph is what the tools read, this is what a person reads.

## Must stay true

Constraints and decisions in force, each with the date it was made and where the reason is recorded
(the node's log). A line here is a rule the owner enforces in every review.

## Ports — what this node promises its neighbours

Each promise is a port in the graph, carrying a version and the test that proves it; the list itself
lives in `yg-node.yaml`, not here. Write only what a reader needs that the graph cannot say: why the
promise exists, and what it deliberately does not cover.

## Open

Questions nobody has answered yet, each with who could.
