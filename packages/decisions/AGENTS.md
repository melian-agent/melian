# Working in packages/decisions

@../../docs/guidelines/decisions.md

## Rules

- Implement core's `Decider` port and parse the written decisions for the design lens. Which adapter answers, and when, is the host's choice; the pipeline runs every decision as a durable task.
- Never import Pi, pi-ai, or `@melian-agent/pipeline`. The LLM fallback asks a model through core's `TextModel` port, which the pipeline implements over a review's models.
- An adapter that cannot answer throws, so its caller fails closed. Never invent an answer, a default distribution included.
- Validate what a model returns against the tool's schema before it leaves the adapter. Core's `Decision.parse` checks the answer against the questions.

## Markdown

- Parse written decisions and design sections through MarkdownDocument. mdast owns Markdown syntax; never scan source text for links, definitions, images, headings or fences.
- Resolve destinations through LocalDestination. It uses WHATWG URL parsing before URI decoding and repository boundary checks. Encode the declaring file’s path before constructing the base URL: Git filenames can contain newlines, hash signs and question marks.
- Use mdast-util-definitions for references, mdast-util-to-string for heading text and github-slugger for heading IDs. YAML and TOML front matter are metadata. HTML nodes contribute no prose.
- Supersedes declarations come from paragraph nodes. Bare filenames remain supported within their text nodes. Target filenames use the same domain as discovery: every Markdown file under docs/decisions, including nested, undated and Unicode names.
- Keep one table per input concern, with a positive and negative case in each row. Prove changed guards with failing mutations before committing.

## Running the tests

- Whole package: `npm test --workspace @melian-agent/decisions`. The adapters are tested against a stub text model here; the LLM fallback on the fake model runs in the pipeline's `test/triage.test.ts`.

When inspecting mdast parser results in a test, use Vitest’s module spy option. Native ESM exports are not configurable, so vi.spyOn on their namespace fails. The spy still calls the real parser.

npm test --workspace runs with the package as its working directory. A test reading the real checkout resolves its root from import.meta.url, rather than process.cwd().
