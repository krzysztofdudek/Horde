# 065 · product language s description omits two of the four

**Status:** open
**Kind:** bug
**Priority:** 2
**Model:** sonnet
**Tags:** kontrakt, pakiet
**Files:** packages/promises/product-language/yg-aspect.yaml
**Found by:** workflow finder package-vs-docs, confirmed by two refuters
**Where:** packages/promises/product-language/yg-aspect.yaml:2

## What
product-language's description omits two of the four refused categories (table name, field name)

The aspect's description reads: "A promise says what the software does in the product's own words — never an identifier, a path, an address, a verb and a code, or a selector." That names: identifier (camel/snake/pascal), path (file-path), address (url-path), "a verb and a code" (http-verb, http-status-code), and a selector (css-selector) — six of the eight distinct regex categories. It never mentions the other two categories check.mjs actually implements and refuses: `table-name` (packages/promises/product-language/check.mjs:26-30, label 'a table name') and `field-name` (check.mjs:32-36, label 'a field name'). Both have dedicated drill cases (`product-language/drills/violates-table-name/`, `violates-field-name/`) and dedicated tests in promises-package.test.mjs ('a table name in the body is refused', 'a field name in the body is refused'), so they are load-bearing, intentional categories — just missing from the one sentence a reader/adopter sees describing what the rule refuses.

## Why
An adopter deciding whether/how to use this rule, or writing a promise and wondering why 'the orders table' or 'the delivery_note field' got refused, reads the aspect description as the contract; it does not mention table or field names at all, so the refusal for those two categories looks unexplained by the rule's own stated scope.

## Acceptance
A description that enumerates (or at least gestures at) every category the check actually enforces, the way doc-shape's and has-evidence's descriptions match their checks exactly.

Dowód, którego oczekuję: Read packages/promises/product-language/yg-aspect.yaml line 2 next to the CATEGORIES table in check.mjs (lines 24-85): the description's word list has no term covering 'table-name' or 'field-name', while the code has ten total category entries (two of which share the 'a code identifier' label) collapsing to eight distinct refused shapes, and none of the description's clauses cover the table/field ones the way 'a path' clearly maps to file-path.

Refuterzy: Confirmed. yg-aspect.yaml:2 reads: "A promise says what the software does in the product's own words — never an identifier, a path, an address, a verb and a code, or a selector." This covers camel/sna | Confirmed. yg-aspect.yaml line 2 description ("never an identifier, a path, an address, a verb and a code, or a selector") maps to camel/snake/pascal-case identifiers, file-path, url-path, http-verb, 

## Evidence

