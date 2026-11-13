# The Timing line has a fixed form

Amends: [A builder reports the time GitHub can't see](2026-11-04-timing-line.md), the form of the `Timing:` line.

Status: asked for by the maintainer on 2026-11-13, in the coordinator's session, as [issue #401](https://github.com/melian-agent/melian/issues/401); built in [pull request #403](https://github.com/melian-agent/melian/pull/403).

## Problem

The first decision named what a `Timing:` line reports but gave it no form, so each builder wrote its own. A rollup of the last 20 merged pull requests found 16 lines the timeline script could not read and 15 with no duration. The script also half-counted free text: it took any words before `<minutes> min` as a label.

Example: "gate 4 × about 13 min" counted as 13 minutes under the label "gate 4 × about", and "mutation runs 25 min and 6 min" as 6. On [pull request #387](https://github.com/melian-agent/melian/pull/387) the script reported 152 minutes, where a careful reading finds 109 minutes it can stand behind.

## Decision

- The line holds items separated by `;`. Each is `<kind> <count> × <minutes> min`, then optionally `, $<cost>`, then `for <cause>` on a wait alone, then optionally a note in brackets. AGENTS.md's Work from issues sets it out.
- The kinds are a closed list: `gate`, `round`, `own-build round`, `host round`, `codex`, `review of record`, `mutants`, `wait` and `other`. A `wait` must name its cause, and an `other` must carry a note.
- The minutes are for each of the count, and the cost is the item's whole cost. A count of one may be left out.
- One number of minutes per item: no ranges, no "about", and no lists inside an item.
- `scripts/timeline.mjs` totals minutes and cost per kind, and sums the summary's total from those rows.
- An item the script cannot parse is listed under its own heading and counted nowhere.
- Older lines still count where they begin with a known kind, a plural of one, an alias such as "Codex review" or "Actions round", or `waited <minutes> min for`. Everything else in them is listed as unparsed. Old comments are not rewritten.

## Why

A closed list of kinds is what makes a total per kind possible, and a strict item is what makes a total trustworthy. A visible list of what did not parse keeps a bad line from vanishing or half-counting.

## What it gives up

Totals over old pull requests change. An item written with "about", a range or a free label, such as "review 2 min", no longer counts, so the minutes reported for #387 fall from 152 to 109. The unparsed list shows each such item, so a reader can still see the time it claimed.
