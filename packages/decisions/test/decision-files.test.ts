import { fileURLToPath } from "node:url";
import { openSource, visibleText } from "@melian-agent/core";
import { DecisionFile, DecisionFiles, decisionIndexLimits } from "@melian-agent/decisions";
import { describe, expect, it, vi } from "vitest";
import { gitIn, removeDirectory, temporaryDirectory, writeFiles } from "../../core/test/fixtures/repo.ts";

const a = "docs/decisions/2026-10-01-a.md";
const b = "docs/decisions/2026-10-02-b.md";
const c = "docs/decisions/2026-10-03-c.md";
const parse = (path: string, text: string) => DecisionFile.parse(path, text);
const declarationCases: [
	name: string,
	positive: string,
	targets: string[],
	negative: string,
	negativeTargets: string[],
	from?: string,
][] = [
	[
		"code example 0",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"```md\nSupersedes: [A](2026-10-01-a.md)\n```",
		[],
	],
	[
		"code example 1",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"~~~md\nSupersedes: 2026-10-01-a.md\n~~~",
		[],
	],
	[
		"code example 2",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"    Supersedes: [A](2026-10-01-a.md)",
		[],
	],
	[
		"code example 3",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"`Supersedes: [A](2026-10-01-a.md)`",
		[],
	],
	[
		"code example 4",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"`Example:\nSupersedes: [A](2026-10-01-a.md)\n`",
		[],
	],
	[
		"code example 5",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: `[A](2026-10-01-a.md)`",
		[],
	],
	[
		"code example 6",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: `2026-10-01-a.md`",
		[],
	],
	[
		'[2026-10-02-b.md](2026-10-01-a.md "See 2026-10-02-b.md")',
		'Supersedes: [2026-10-02-b.md](2026-10-01-a.md "See 2026-10-02-b.md")',
		["docs/decisions/2026-10-01-a.md"],
		'Context: [2026-10-02-b.md](2026-10-01-a.md "See 2026-10-02-b.md")',
		[],
	],
	[
		"[2026-10-02-b.md](2026-10-01-a.md 'See 2026-10-02-b.md')",
		"Supersedes: [2026-10-02-b.md](2026-10-01-a.md 'See 2026-10-02-b.md')",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [2026-10-02-b.md](2026-10-01-a.md 'See 2026-10-02-b.md')",
		[],
	],
	[
		"[2026-10-02-b.md](2026-10-01-a.md (See 2026-10-02-b.md))",
		"Supersedes: [2026-10-02-b.md](2026-10-01-a.md (See 2026-10-02-b.md))",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [2026-10-02-b.md](2026-10-01-a.md (See 2026-10-02-b.md))",
		[],
	],
	[
		'[**2026-10-02-b.md** and [context]]( <2026-10-01-a.md> "See 2026-10-02-b.md")',
		'Supersedes: [**2026-10-02-b.md** and [context]]( <2026-10-01-a.md> "See 2026-10-02-b.md")',
		["docs/decisions/2026-10-01-a.md"],
		'Context: [**2026-10-02-b.md** and [context]]( <2026-10-01-a.md> "See 2026-10-02-b.md")',
		[],
	],
	[
		"[`2026-10-02-b.md`](2026-10-01-a.md)",
		"Supersedes: [`2026-10-02-b.md`](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [`2026-10-02-b.md`](2026-10-01-a.md)",
		[],
	],
	[
		"[`2026-10-02-b.md`][context]\n\n[context]: 2026-10-01-a.md",
		"Supersedes: [`2026-10-02-b.md`][context]\n\n[context]: 2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [`2026-10-02-b.md`][context]\n\n[context]: 2026-10-01-a.md",
		[],
	],
	[
		'[A](2026-10-01-a.md "See \\"2026-10-02-b.md\\"")',
		'Supersedes: [A](2026-10-01-a.md "See \\"2026-10-02-b.md\\"")',
		["docs/decisions/2026-10-01-a.md"],
		'Context: [A](2026-10-01-a.md "See \\"2026-10-02-b.md\\"")',
		[],
	],
	[
		'[A](2026-10-01-a.md\n "See 2026-10-02-b.md")',
		'Supersedes: [A](2026-10-01-a.md\n "See 2026-10-02-b.md")',
		["docs/decisions/2026-10-01-a.md"],
		'Context: [A](2026-10-01-a.md\n "See 2026-10-02-b.md")',
		[],
	],
	[
		"[A](./2026-10-01-a.md#2026-10-02-b.md)",
		"Supersedes: [A](./2026-10-01-a.md#2026-10-02-b.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [A](./2026-10-01-a.md#2026-10-02-b.md)",
		[],
	],
	[
		"[A](2026-10-01-a.md?context=2026-10-02-b.md)",
		"Supersedes: [A](2026-10-01-a.md?context=2026-10-02-b.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [A](2026-10-01-a.md?context=2026-10-02-b.md)",
		[],
	],
	[
		"[A](%32%30%32%36-10-01-a.md)",
		"Supersedes: [A](%32%30%32%36-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [A](%32%30%32%36-10-01-a.md)",
		[],
	],
	[
		"[A](2026-10-01-a&#46;md)",
		"Supersedes: [A](2026-10-01-a&#46;md)",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [A](2026-10-01-a&#46;md)",
		[],
	],
	[
		"[A](/docs/decisions/2026-10-01-a.md)",
		"Supersedes: [A](/docs/decisions/2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [A](/docs/decisions/2026-10-01-a.md)",
		[],
	],
	[
		'[A][ Context ]\n\n[context]: <2026-10-01-a.md> "See 2026-10-02-b.md"',
		'Supersedes: [A][ Context ]\n\n[context]: <2026-10-01-a.md> "See 2026-10-02-b.md"',
		["docs/decisions/2026-10-01-a.md"],
		'Context: [A][ Context ]\n\n[context]: <2026-10-01-a.md> "See 2026-10-02-b.md"',
		[],
	],
	[
		"[Context][]\n\n[context]: 2026-10-01-a.md 'See 2026-10-02-b.md'",
		"Supersedes: [Context][]\n\n[context]: 2026-10-01-a.md 'See 2026-10-02-b.md'",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [Context][]\n\n[context]: 2026-10-01-a.md 'See 2026-10-02-b.md'",
		[],
	],
	[
		"[Context]\n\n[context]: 2026-10-01-a.md (See 2026-10-02-b.md)",
		"Supersedes: [Context]\n\n[context]: 2026-10-01-a.md (See 2026-10-02-b.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [Context]\n\n[context]: 2026-10-01-a.md (See 2026-10-02-b.md)",
		[],
	],
	[
		"[Context]\n\n[context]: 2026-10-01-a.md\n[context]: 2026-10-02-b.md",
		"Supersedes: [Context]\n\n[context]: 2026-10-01-a.md\n[context]: 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [Context]\n\n[context]: 2026-10-01-a.md\n[context]: 2026-10-02-b.md",
		[],
	],
	[
		"[A](<nested (old)/2026-10-01-a.md> 'See 2026-10-02-b.md')",
		"Supersedes: [A](<nested (old)/2026-10-01-a.md> 'See 2026-10-02-b.md'), 2026-10-02-b.md",
		["docs/decisions/nested (old)/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: none. [A](<nested (old)/2026-10-01-a.md> 'See 2026-10-02-b.md')",
		[],
	],
	[
		"[A](nested(old)/2026-10-01-a.md (See 2026-10-02-b.md))",
		"Supersedes: [A](nested(old)/2026-10-01-a.md (See 2026-10-02-b.md)), 2026-10-02-b.md",
		["docs/decisions/nested(old)/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: none. [A](nested(old)/2026-10-01-a.md (See 2026-10-02-b.md))",
		[],
	],
	[
		"[A](nested\\(old\\)/2026-10-01-a.md)",
		"Supersedes: [A](nested\\(old\\)/2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/nested(old)/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: none. [A](nested\\(old\\)/2026-10-01-a.md)",
		[],
	],
	[
		"[A](nested%28old%29/2026-10-01-a.md)",
		"Supersedes: [A](nested%28old%29/2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/nested(old)/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: none. [A](nested%28old%29/2026-10-01-a.md)",
		[],
	],
	[
		"[A](nested(old)/deep(inner)/2026-10-01-a.md)",
		"Supersedes: [A](nested(old)/deep(inner)/2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/nested(old)/deep(inner)/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: none. [A](nested(old)/deep(inner)/2026-10-01-a.md)",
		[],
	],
	[
		"[A](<nested&#10;/2026-10-01-a.md>)",
		"Supersedes: [A](<nested&#10;/2026-10-01-a.md>), 2026-10-02-b.md",
		["docs/decisions/nested\n/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: none. [A](<nested&#10;/2026-10-01-a.md>)",
		[],
	],
	[
		"[A](<nested&#xA;/2026-10-01-a.md>)",
		"Supersedes: [A](<nested&#xA;/2026-10-01-a.md>), 2026-10-02-b.md",
		["docs/decisions/nested\n/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: none. [A](<nested&#xA;/2026-10-01-a.md>)",
		[],
	],
	[
		"[A](nested%0A/2026-10-01-a.md)",
		"Supersedes: [A](nested%0A/2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/nested\n/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: none. [A](nested%0A/2026-10-01-a.md)",
		[],
	],
	[
		"nested/writer:trust/2026-10-01-a.md",
		"Supersedes: [A](nested/writer:trust/2026-10-01-a.md)",
		["docs/decisions/nested/writer:trust/2026-10-01-a.md"],
		"Supersedes: [A](https://example.com/nested/writer:trust/2026-10-01-a.md)",
		[],
	],
	[
		"./writer:trust/2026-10-01-a.md",
		"Supersedes: [A](./writer:trust/2026-10-01-a.md)",
		["docs/decisions/writer:trust/2026-10-01-a.md"],
		"Supersedes: [A](https://example.com/./writer:trust/2026-10-01-a.md)",
		[],
	],
	[
		"nested/writer%3Atrust/2026-10-01-a.md",
		"Supersedes: [A](nested/writer%3Atrust/2026-10-01-a.md)",
		["docs/decisions/nested/writer:trust/2026-10-01-a.md"],
		"Supersedes: [A](https://example.com/nested/writer%3Atrust/2026-10-01-a.md)",
		[],
	],
	[
		"writer%3Atrust/2026-10-01-a.md",
		"Supersedes: [A](writer%3Atrust/2026-10-01-a.md)",
		["docs/decisions/writer:trust/2026-10-01-a.md"],
		"Supersedes: [A](https://example.com/writer%3Atrust/2026-10-01-a.md)",
		[],
	],
	[
		"https%3A/host/2026-10-01-a.md",
		"Supersedes: [A](https%3A/host/2026-10-01-a.md)",
		["docs/decisions/https:/host/2026-10-01-a.md"],
		"Supersedes: [A](https://example.com/https%3A/host/2026-10-01-a.md)",
		[],
	],
	[
		"https:nested/2026-10-01-a.md",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: [External](https:nested/2026-10-01-a.md)",
		[],
	],
	[
		"HTTPS:nested/2026-10-01-a.md",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: [External](HTTPS:nested/2026-10-01-a.md)",
		[],
	],
	[
		"mailto:nested/2026-10-01-a.md",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: [External](mailto:nested/2026-10-01-a.md)",
		[],
	],
	[
		"file:nested/2026-10-01-a.md",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: [External](file:nested/2026-10-01-a.md)",
		[],
	],
	[
		"https://example.com/%ZZ/2026-10-01-a.md",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: [External](https://example.com/%ZZ/2026-10-01-a.md)",
		[],
	],
	[
		"//example.com/%ZZ/2026-10-01-a.md",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: [External](//example.com/%ZZ/2026-10-01-a.md)",
		[],
	],
	[
		"[`2026-10-02-b.md`](2026-10-01-a.md), 2026-10-02-b.md",
		"Supersedes: [`2026-10-02-b.md`](2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: no decision file. [`2026-10-02-b.md`](2026-10-01-a.md), 2026-10-02-b.md",
		[],
	],
	[
		"[`2026-10-02-b.md`][context], 2026-10-02-b.md\n\n[context]: 2026-10-01-a.md",
		"Supersedes: [`2026-10-02-b.md`][context], 2026-10-02-b.md\n\n[context]: 2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: no decision file. [`2026-10-02-b.md`][context], 2026-10-02-b.md\n\n[context]: 2026-10-01-a.md",
		[],
	],
	[
		"[2026-10-01-a.md](https://example.com/2026-10-01-a.md)",
		"Supersedes: [A](2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: [2026-10-01-a.md](https://example.com/2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-02-b.md"],
	],
	[
		"[2026-10-01-a.md](//example.com/2026-10-01-a.md)",
		"Supersedes: [A](2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: [2026-10-01-a.md](//example.com/2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-02-b.md"],
	],
	[
		"[2026-10-01-a.md](#2026-10-01-a.md)",
		"Supersedes: [A](2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: [2026-10-01-a.md](#2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-02-b.md"],
	],
	[
		"undated query destination",
		"Supersedes: [2026-10-01-a.md](notes.md?next=2026-10-01-a.md)",
		["docs/decisions/notes.md"],
		"Supersedes: [2026-10-01-a.md](notes.txt?next=2026-10-01-a.md)",
		[],
	],
	[
		"[2026-10-01-a.md](2026-10-01-a.md.bak)",
		"Supersedes: [A](2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: [2026-10-01-a.md](2026-10-01-a.md.bak), 2026-10-02-b.md",
		["docs/decisions/2026-10-02-b.md"],
	],
	[
		"Markdown directory name",
		"Supersedes: [2026-10-01-a.md](2026-10-01-a.md/other.md)",
		["docs/decisions/2026-10-01-a.md/other.md"],
		"Supersedes: [2026-10-01-a.md](2026-10-01-a.md/other.txt)",
		[],
	],
	[
		"<https://example.com/2026-10-01-a.md>",
		"Supersedes: [A](2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: <https://example.com/2026-10-01-a.md>, 2026-10-02-b.md",
		["docs/decisions/2026-10-02-b.md"],
	],
	[
		"bare ordered targets",
		"Supersedes:2026-10-01-a.md, 2026-10-02-b.md; 2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Context: 2026-10-01-a.md",
		[],
	],
	[
		"soft line declarations",
		"Context: a\nSupersedes: 2026-10-01-a.md\nContext: 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md"],
		"Context: a\nContext: 2026-10-01-a.md",
		[],
	],
	[
		"hard line declarations",
		"Context: a  \nSupersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: [A](2026-10-01-a.md)  \n[B](2026-10-02-b.md)",
		["docs/decisions/2026-10-01-a.md"],
	],
	[
		"link and bare order",
		"Supersedes: 2026-10-02-b.md, [A](2026-10-01-a.md), 2026-10-03-c.md",
		["docs/decisions/2026-10-02-b.md", "docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-03-c.md"],
		"Supersedes: [B](2026-10-02-b.md), [A](2026-10-01-a.md), 2026-10-03-c.md",
		["docs/decisions/2026-10-02-b.md", "docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-03-c.md"],
	],
	[
		"bare formatting",
		"**Supersedes:** **2026-10-01-a.md**.",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: **none**. [A](2026-10-01-a.md)",
		[],
	],
	["absence filename extension", "Supersedes: none.md", ["docs/decisions/none.md"], "Supersedes: none.", []],
	[
		"absence filename hyphen",
		"Supersedes: none-policy.md",
		["docs/decisions/none-policy.md"],
		"Supersedes: none. The [x](2026-10-04-x.md) stays context",
		[],
	],
	[
		"absence phrase extension",
		"Supersedes: no decision file.md",
		["docs/decisions/file.md"],
		"Supersedes: no decision file. It cites [x](2026-10-04-x.md)",
		[],
	],
	["absence filename prefix", "Supersedes: nonesuch.md", ["docs/decisions/nonesuch.md"], "Supersedes: NONE", []],
	["absence whitespace", "Supersedes: none.md", ["docs/decisions/none.md"], "Supersedes: none old.md", []],
	["absence comma", "Supersedes: none-policy.md", ["docs/decisions/none-policy.md"], "Supersedes: none,old.md", []],
	["absence semicolon", "Supersedes: nonesuch.md", ["docs/decisions/nonesuch.md"], "Supersedes: none;old.md", []],
	["absence phrase end", "Supersedes: file.md", ["docs/decisions/file.md"], "Supersedes: NO DECISION FILE", []],
	[
		"absence phrase linked filename",
		"Supersedes: no decision file.md [Old](<no decision file.md>)",
		["docs/decisions/file.md", "docs/decisions/no decision file.md"],
		"Supersedes: no decision file. The [Old](<no decision file.md>) stays context",
		[],
	],
	[
		"absence anchored prefix",
		"Supersedes: old.md none",
		["docs/decisions/old.md"],
		"Supersedes:   none. [Old](old.md)",
		[],
	],
	["bare boundary end", "Supersedes: old.md", ["docs/decisions/old.md"], "Supersedes: old.md.bak", []],
	["bare boundary space", "Supersedes: old.md context", ["docs/decisions/old.md"], "Supersedes: old.md!", []],
	[
		"bare boundary comma",
		"Supersedes: old.md,other.md",
		["docs/decisions/old.md", "docs/decisions/other.md"],
		"Supersedes: old.md:other.txt",
		[],
	],
	[
		"bare boundary semicolon",
		"Supersedes: old.md;other.md",
		["docs/decisions/old.md", "docs/decisions/other.md"],
		"Supersedes: old.md-other.txt",
		[],
	],
	["bare boundary full stop end", "Supersedes: old.md.", ["docs/decisions/old.md"], "Supersedes: old.md.bak", []],
	[
		"bare boundary full stop space",
		"Supersedes: old.md. Context",
		["docs/decisions/old.md"],
		"Supersedes: old.md.Context",
		[],
	],
	[
		"absence case",
		"Supersedes: nonetheless.md",
		["docs/decisions/nonetheless.md"],
		"Supersedes: None. [A](2026-10-01-a.md)",
		[],
	],
	[
		"absence phrase",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: no **decision** file. [A](2026-10-01-a.md)",
		[],
	],
	[
		"image opacity",
		"Supersedes: [A](2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: ![2026-10-01-a.md](2026-10-01-a.md), 2026-10-02-b.md",
		["docs/decisions/2026-10-02-b.md"],
	],
	[
		"reference image opacity",
		"Supersedes: [A][old], 2026-10-02-b.md\n\n[old]: 2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md"],
		"Supersedes: ![2026-10-01-a.md][old], 2026-10-02-b.md\n\n[old]: 2026-10-01-a.md",
		["docs/decisions/2026-10-02-b.md"],
	],
	[
		"HTML opacity",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: <!-- 2026-10-01-a.md -->",
		[],
	],
	[
		"HTML block opacity",
		"Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"<div>\nSupersedes: [A](2026-10-01-a.md)\n</div>",
		[],
	],
	[
		"opaque declaration prefix",
		"Supersedes: 2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md"],
		"`x`Supersedes: 2026-10-01-a.md",
		[],
	],
	[
		"link separates prose tokens",
		"Supersedes: [Old](old.md)",
		["docs/decisions/old.md"],
		"Supersedes: old[Context](context.txt).md",
		[],
	],
	[
		"compact delimiters",
		"Supersedes:2026-10-01-a.md;2026-10-02-b.md,old.md",
		["docs/decisions/2026-10-01-a.md", "docs/decisions/2026-10-02-b.md", "docs/decisions/old.md"],
		"Context:2026-10-01-a.md;2026-10-02-b.md,old.md",
		[],
	],
	["code separates prose tokens", "Supersedes: old.md", ["docs/decisions/old.md"], "Supersedes: old`x`.md", []],
	[
		"label text opacity",
		"Supersedes: [See phantom.md](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"Context: [See phantom.md](2026-10-01-a.md)",
		[],
	],
	["HTML declaration prefix", "Supersedes: old.md", ["docs/decisions/old.md"], "Super<i>sedes: old.md", []],
	[
		"image declaration prefix",
		"Supersedes: old.md",
		["docs/decisions/old.md"],
		"![x](ignored.png)Supersedes: old.md",
		[],
	],
	[
		"reference image declaration prefix",
		"Supersedes: old.md",
		["docs/decisions/old.md"],
		"![x][img]Supersedes: old.md\n\n[img]: ignored.png",
		[],
	],
	[
		"block quote",
		" > Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		" > ```md\n > Supersedes: [A](2026-10-01-a.md)\n > ```",
		[],
	],
	[
		"list paragraph",
		"- Supersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"    Supersedes: [A](2026-10-01-a.md)",
		[],
	],
	[
		"punctuation bound",
		"Supersedes: 2026-10-01-a.md.",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: 2026-10-01-a.md.bak",
		[],
	],
	[
		"unused definition",
		"Supersedes: [A][old]\n\n[old]: 2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: [A][unknown]\n\n[old]: 2026-10-01-a.md",
		[],
	],
	[
		"front matter ---",
		"---\nSupersedes: 2026-10-02-b.md\n---\nSupersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"---\nSupersedes: 2026-10-01-a.md\n---\nContext only",
		[],
	],
	[
		"front matter +++",
		"+++\nSupersedes: 2026-10-02-b.md\n+++\nSupersedes: [A](2026-10-01-a.md)",
		["docs/decisions/2026-10-01-a.md"],
		"+++\nSupersedes: 2026-10-01-a.md\n+++\nContext only",
		[],
	],
	[
		"nested display label",
		"Supersedes: [2026-10-01-a.md](nested/2026-10-01-a.md)",
		["docs/decisions/nested/2026-10-01-a.md"],
		"Context: [2026-10-01-a.md](nested/2026-10-01-a.md)",
		[],
	],
	[
		"nested sibling",
		"Supersedes: 2026-10-01-a.md",
		["docs/decisions/nested/2026-10-01-a.md"],
		"Supersedes: ../2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md"],
		"docs/decisions/nested/2026-10-02-b.md",
	],
	[
		"repository-relative nested",
		"Supersedes: docs/decisions/2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md"],
		"Supersedes: /docs/decisions/2026-10-01-a.md",
		["docs/decisions/2026-10-01-a.md"],
		"docs/decisions/nested/2026-10-02-b.md",
	],
	[
		"declaring path controls",
		"Supersedes: old.md",
		["docs/decisions/nested\n#?/old.md"],
		"Supersedes: none. old.md",
		[],
		"docs/decisions/nested\n#?/new.md",
	],
	[
		"child target",
		"Supersedes: nested/2026-10-01-a.md",
		["docs/decisions/nested/2026-10-01-a.md"],
		"Supersedes: [Old](//melian-repository/repository/docs/decisions/2026-10-01-a.md)",
		[],
		"docs/decisions/2026-10-03-c.md",
	],
];

describe("supersession prose", () => {
	it.each(declarationCases)("%s", (_name, positive, targets, negative, negativeTargets, from = c) => {
		expect(parse(from, positive).supersedes).toEqual(targets);
		expect(parse(from, negative).supersedes).toEqual(negativeTargets);
		const files = [...new Set([a, b, from, ...targets, ...negativeTargets])].map((path) =>
			parse(path, path === from ? positive : "# Baseline"),
		);
		if (!targets.includes(from)) {
			const rendered = DecisionFiles.from(files).render();
			for (const target of targets)
				expect(rendered).toContain(visibleText(`[INACTIVE; superseded by ${from}] ${target}`));
			for (const target of [a, b].filter((path) => !targets.includes(path)))
				expect(rendered).toContain(`[ACTIVE] ${target}`);
		}
	});
});

const lineEndingCases: [name: string, positive: string][] = [
	...["\r", "\r\n", "\n"].flatMap<[string, string]>((ending) => [
		[
			`declaration after prose ${JSON.stringify(ending)}`,
			`# New${ending}${ending}Context: a${ending}Supersedes: old.md`,
		],
		[
			`contextual link after declaration ${JSON.stringify(ending)}`,
			`# New${ending}${ending}Supersedes: old.md${ending}Context: [context](context.md)`,
		],
		[
			`declaration after sentinel ${JSON.stringify(ending)}`,
			`# New${ending}${ending}Supersedes: none${ending}Supersedes: old.md`,
		],
	]),
	["review reproduction: CR after prose", "# New\r\rContext: a\rSupersedes: old.md"],
	["review reproduction: mixed after prose", "# New\n\nContext: a\rSupersedes: old.md\r\nAfter"],
	["review reproduction: CR contextual link", "# New\r\rSupersedes: old.md\rContext: [context](context.md)"],
	["review reproduction: CR sentinel", "# New\r\rSupersedes: none\rSupersedes: old.md"],
	[
		"mixed contextual link after declaration",
		"# New\r\n\r\nSupersedes: old.md\rContext: [context](context.md)\nAfter",
	],
	["mixed declaration after sentinel", "# New\r\n\r\nSupersedes: none\rSupersedes: old.md\nAfter"],
];

describe("CommonMark declaration line boundaries", () => {
	it.each(lineEndingCases.map(([name, positive]) => [name, positive, `~~~md\n${positive}\n~~~`] as const))(
		"%s",
		(_name, positive, negative) => {
			const fresh = parse("docs/decisions/new.md", positive);
			expect(fresh.supersedes).toEqual(["docs/decisions/old.md"]);
			expect(parse(fresh.path, negative).supersedes).toEqual([]);
			expect(
				DecisionFiles.from([
					parse("docs/decisions/old.md", "# Old"),
					parse("docs/decisions/context.md", "# Context"),
					fresh,
				]).render(),
			).toEqual(
				"[ACTIVE] docs/decisions/context.md — Context\n" +
					"[ACTIVE] docs/decisions/new.md — New\n" +
					"[INACTIVE; superseded by docs/decisions/new.md] docs/decisions/old.md — Old",
			);
		},
	);
});

const filenameCases = [
	["dated", "2026-10-01-a.md", "2026-10-01-a.md.bak"],
	["undated", "policy.md", "policy.txt"],
	["Unicode", "café.md", "café.MD"],
	["space", "writer trust.md", "writer trust.md/other.txt"],
	["newline", "line\nbreak.md", "line\nbreak.md.bak"],
	["terminal newline", "line\nbreak.md", "linebreak.md\n"],
	["nested", "nested/old.md", "../outside.md"],
	["colon", "nested/writer:trust.md", "https:writer.md"],
	["empty basename", ".md", ".md.bak"],
] as const;

describe("filename domain", { timeout: 60_000 }, () => {
	it("keeps literal filename padding distinct from an unpadded decision", async () => {
		const padded = "docs/decisions/ old.md";
		const plain = "docs/decisions/old.md";
		expect(parse(b, "Supersedes: [Old](< old.md>)").supersedes).toEqual([padded]);
		expect(parse(b, "Supersedes: [Old](<old.md >)").supersedes).toEqual([]);
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				[padded]: "# Padded",
				[plain]: "# Plain",
				[b]: "# New\nSupersedes: [Old](< old.md>)",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			const rendered = (await DecisionFiles.load(repo, "HEAD")).render();
			expect(rendered).toContain(`[INACTIVE; superseded by ${b}] ${padded} — Padded`);
			expect(rendered).toContain(`[ACTIVE] ${plain} — Plain`);
		} finally {
			removeDirectory(repo);
		}
	});
	it.each(filenameCases)("%s", async (_name, filename, excluded) => {
		const target = `docs/decisions/${filename}`;
		const destination = filename.split("/").map(encodeURIComponent).join("/");
		expect(parse(b, `Supersedes: [Old](<${destination}>)`).supersedes).toEqual([target]);
		expect(parse(b, `Supersedes: [Old](<${excluded.replaceAll("\n", "%0A")}>)`).supersedes).toEqual([]);
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				[target]: "# Old",
				[b]: `# New\nSupersedes: [Old](<${destination}>)`,
				"docs/progress-log/policy.md": "# Excluded",
				"docs/decisions/notes.md\n": "# Excluded terminal newline",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			const rendered = (await DecisionFiles.load(repo, "HEAD")).render();
			expect(rendered).toContain(visibleText(`[INACTIVE; superseded by ${b}] ${target} — Old`));
			expect(rendered).not.toContain("Excluded");
		} finally {
			removeDirectory(repo);
		}
	});
});

const titleCases = [
	["ATX", "# Title", "## Other"],
	["Setext", "Title\n=====", "    # Example"],
	["first H1", "## Other\n# Title\n# Later", "```md\n# Example\n```"],
	["YAML metadata", "---\n# Metadata\n---\n# Title", "---\n# Metadata\n---"],
	["TOML metadata", "+++\n# Metadata\n+++\n# Title", "+++\n# Metadata\n+++"],
	["markup", "# *Title*", "Context"],
] as const;

describe("decision titles", () => {
	it.each(titleCases)("%s", (_name, positive, negative) => {
		expect(parse(a, positive).title).toBe("Title");
		expect(parse(a, negative).title).toBe(a);
	});
});

describe("written decisions", () => {
	it("marks every superseded decision inactive, including a chain and two successors", () => {
		const rendered = DecisionFiles.from([
			parse(c, "# C\nSupersedes: 2026-10-01-a.md, 2026-10-02-b.md\n"),
			parse(b, "# B\nSupersedes: 2026-10-01-a.md\n"),
			parse(a, "# A\n"),
		]).render();
		expect(rendered.split("\n").slice(0, 3)).toEqual([
			`[INACTIVE; superseded by ${c}, ${b}] ${a} — A`,
			`[INACTIVE; superseded by ${c}] ${b} — B`,
			`[ACTIVE] ${c} — C`,
		]);
	});

	it("refuses a missing target or a cycle, including a self-reference", () => {
		expect(() => DecisionFiles.from([parse(b, "# B\nSupersedes: 2026-10-01-a.md\n")])).toThrow(/supersedes absent/);
		expect(() =>
			DecisionFiles.from([parse(a, "Supersedes: 2026-10-02-b.md\n"), parse(b, "Supersedes: 2026-10-01-a.md\n")]),
		).toThrow(/cycle/);
		expect(() => DecisionFiles.from([parse(a, "Supersedes: 2026-10-01-a.md\n")])).toThrow(/cycle/);
		expect(DecisionFiles.from([]).render()).not.toContain("[and");
	});

	it("pins the byte bound and refuses one byte past it without shortening a title", () => {
		expect(decisionIndexLimits).toEqual({ bytes: 65536 });
		const prefix = `[ACTIVE] ${a} — `;
		const title = "x".repeat(65536 - Buffer.byteLength(prefix));
		expect(DecisionFiles.from([parse(a, `# ${title}`)]).render()).toBe(prefix + title);
		expect(() => DecisionFiles.from([parse(a, `# ${title}x`)]).render()).toThrow(
			"1 decisions omitted; review refused",
		);
		expect(() => DecisionFiles.from([parse(a, `# ${title.slice(1)}é`)]).render()).toThrow(
			"1 decisions omitted; review refused",
		);
		expect(DecisionFiles.from([parse(a, "# hidden\ttitle")]).render()).toContain("hidden\\u0009title");
	});
	it("names every omitted decision when the complete index cannot fit", () => {
		const files = [parse(a, `# ${"x".repeat(65536)}`), parse(b, "# B")];
		expect(() => DecisionFiles.from(files).render()).toThrow("2 decisions omitted; review refused");
	});
	it("lists every active path and full title at the repository base with headroom", async () => {
		const repo = fileURLToPath(new URL("../../../", import.meta.url));
		const source = await openSource(repo, { kind: "revision", commit: "origin/main" });
		const paths = await source.findPaths(/^docs\/decisions\/.*\.md$/s);
		const files = await Promise.all(
			paths.map(async (path) => parse(path, (await source.readText(path, 256 * 1024))!)),
		);
		const inactive = new Set(files.flatMap((file) => [...file.supersedes]));
		const active = files.filter((file) => !inactive.has(file.path));
		expect(active.length).toBeGreaterThan(100);
		const rendered = (await DecisionFiles.load(repo, "origin/main")).render();
		for (const file of active)
			expect(rendered.split("\n")).toContain(visibleText(`[ACTIVE] ${file.path} — ${file.title}`));
		expect(Buffer.byteLength(rendered)).toBeLessThan(49152);
	}, 60_000);
});

describe("base decision reads", () => {
	it("loads base, including nested files removed at head, and ignores other directories", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, {
				[a]: "# Base title\n",
				[b]: "# B\nSupersedes: 2026-10-01-a.md\n",
				"docs/decisions/nested/2026-10-01-extra.md": "# Nested\n",
				"docs/decisions/2026-10-01-line\nbreak.md": "# Newline path\n",
				"docs/progress-log/2026-10-01-other.md": "# Not a decision\n",
			});
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "base");
			gitIn(repo, "rm", "--quiet", b);
			writeFiles(repo, { [a]: "# Head title\n" });
			gitIn(repo, "commit", "--quiet", "--all", "-m", "head");
			const base = gitIn(repo, "rev-parse", "HEAD~");
			const rendered = (await DecisionFiles.load(repo, base)).render();
			expect(rendered).toContain(`[INACTIVE; superseded by ${b}] ${a} — Base title`);
			expect(rendered).toContain(`[ACTIVE] ${b} — B`);
			expect(rendered).toContain("— Nested");
			expect(rendered).toContain("2026-10-01-line\\u000abreak.md — Newline path");
			expect(rendered).not.toContain("Not a decision");
			expect(rendered).not.toContain("Head title");
			const source = await openSource(repo, { kind: "revision", commit: base });
			const read = vi.spyOn(Object.getPrototypeOf(source), "readText").mockResolvedValue(undefined);
			try {
				await expect(DecisionFiles.load(repo, base)).rejects.toMatchObject({ code: "incomplete" });
			} finally {
				read.mockRestore();
			}
		} finally {
			removeDirectory(repo);
		}
	});

	it("accepts the base read byte bound, rejects one past it, and loads an empty corpus", async () => {
		const repo = temporaryDirectory();
		try {
			gitIn(repo, "init", "--quiet", "--initial-branch=main");
			writeFiles(repo, { "src/index.ts": "export const answer = 42;\n" });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "empty");
			expect((await DecisionFiles.load(repo, "HEAD")).render()).not.toContain("ACTIVE");
			writeFiles(repo, { [a]: `# Title\n${"x".repeat(256 * 1024 - 8)}` });
			gitIn(repo, "add", "--all");
			gitIn(repo, "commit", "--quiet", "-m", "bound");
			expect((await DecisionFiles.load(repo, "HEAD")).render()).toContain("— Title");
			writeFiles(repo, { [a]: `# Title\n${"x".repeat(256 * 1024 - 7)}` });
			gitIn(repo, "commit", "--quiet", "--all", "-m", "past");
			await expect(DecisionFiles.load(repo, "HEAD")).rejects.toMatchObject({ code: "tooLarge" });
		} finally {
			removeDirectory(repo);
		}
	});
});
