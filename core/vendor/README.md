# Vendored lovely-mermaid

`lovely-mermaid/` is the `dist/` of [lovely-mermaid](https://github.com/xl0/lovely-mermaid) 0.3.3 from npm (Apache-2.0, `LICENSE` beside it), vendored so the plugin needs no install step. The plugin's own code never edits these files except through the patches below; `lovely-mermaid.patch` is the full diff against the npm build (`cd dist && patch -p1 < lovely-mermaid.patch`).

## Patches

Terms from lovely's layout: a *rank* is one row (top-down) or column (left-right) of boxes; the *band* is the gap after a rank, where edges jog sideways along a *bus* row or column; an edge's *verb* is its label, its *cards* the ER/class cardinalities at each end.

| Where | What | Why |
|---|---|---|
| `diagrams/pie.js` | Bars are `▆` in whole cells with no `░` track, the longest slice spans the full 24-column bar; labels keep up to 40 columns | Full-cell bars over a full-cell track ran the rows together into one solid block, and the eighth-block ends made a ragged edge. `tests/upstream.mjs` counts `pie/basic.md` as changed on purpose. |
| `layout.js` `contentW`, adjacent back edges | `cx + 2` → `cx + 3` | Upstream 5826e10, released after 0.3.3: a back-edge label lost its last character. |
| `canvas.js`, `layout.js` `placeLabel`, `index.js`, `types.d.ts` | `render()` returns `lostLabels: {label, from, to}[]` | `placeLabel` silently stopped at the first occupied cell, so a label that collided vanished. `fit()` lists them under the drawing. |
| `layout.js` `splitArrivals`, `placeTd`, `busSpans`, `routeForward` call | Top-down: two or more arrivals with a verb or card, from different sources, into one node each get their own entry on its top edge, the box widened to hold them | They shared one arrowhead and every label after the first was lost (`A -->\|x\| C`, `B -->\|y\| C` drew only `x`). |
| `layout.js` `placeLr`, `routeForwardLr`, `routeSkipLr` | Left-right: such arrivals from one band carry their verb above their own departure; that band's buses move right to make room | Same loss, sideways: the verbs shared the cells after the bus column. |
| `layout.js` `routeForward`, source card | The source-end card goes left of its stub when the bus turns left right under the box | It landed on a sibling's run and was lost. |
| `layout.js` `layoutCanvas`, `placeLabel` | Labels wait until every line and arrowhead is drawn, then go down in the order the edges asked | A later edge's line or arrowhead overwrote a label already drawn (`超时未付或用▼取消`). |
| `layout.js` `placeLabel` | A label may cross a plain straight run of another edge when the line shows on both sides of it; a turn, junction, arrowhead, box or label still stops it | Labels go down after every line, so any line already under one would otherwise stop it. |
| `layout.js` `placeLabel`, `routeForward` | A verb beside its arrowhead with no room on the right goes whole to the left of the arrow, when that is clear | Two verbs into neighbouring entries: the second had no room and was lost. |
| `layout.js` `assignPositions`, `placeTd` | Top-down: neighbouring boxes in a rank sit far enough apart for the left one's arrival verb to end before the right one's arrow | A fan-out with a long verb (`A -->\|超时未付 / 用户取消\| C`, `A -->\|支付成功\| B`) cut the verb at the sibling's arrow. |
| `layout.js` `placeTd` (`crowded`), `layoutCanvas` | Top-down: when lovely's own entry placement would stack two or more labelled arrivals from different sources on one arrowhead, the target is split as above (one entry each, the box widened) and the layout runs again | A skip and a forward edge, or two skips, into one box shared an arrowhead and all labels but one were lost. |
| `layout.js` `placeTd` (`crossings`, `permutations`) | A split target's entries go left to right in the order whose lines cross least; laned skips into it approach on a row each, the inner lane higher | Entries in source order made a forward edge cut across a skip's drop; two laned skips merged on one approach row. |
| `layout.js` `routeForward`, ER/class verb | A verb that falls on its own edge's bus row goes past the far end of the jog | It sat on its own line and was cut at the corner. |
| `layout.js` `routeForward`, ER/class cards | When placement put an arrival's text left of its line (`labelLeft`), the target card and the verb go there too | Only plain verbs honoured it; cards and verbs stayed right, under the next entry's line. |
| `layout.js` `layoutCanvas`, rank order | Top-down: within a rank, the ends of back edges that go round by the side come after the ends of skips | Both went last with no order between them, so a back edge leaving a box's side could cut through the skip's target beside it. |

Still lost, and listed under the drawing (1 of the 316 diagrams in `tests/fixtures/common.md`): in left-right layouts, target-end cards of converging arrivals.

## Updating

1. Copy the new `dist/` (with `diagrams/`) over `lovely-mermaid/`, then reapply `lovely-mermaid.patch`, fixing any hunk that no longer applies.
2. Refresh `tests/upstream/cases` from the same upstream commit's `packages/lovely-mermaid/test/cases`.
3. `node tests/upstream.mjs` must pass every case: the patches change nothing upstream already draws.
4. `node tests/corpus.mjs 120` and `80`, then the plugin tests.
