# Written decisions and design sections share the unified Markdown grammar

Supersedes: [The active-base decision](2026-10-08-design-lens-active-decisions-at-base.md), only its Markdown parser and filename rules. Its baseline, graph, prompt and byte-bound choices remain.

Problem: eleven review rounds found defects in hand-written handling of links, references, headings, fences and Supersedes lines. Each repair added another syntax exception. The loader and supersession matcher also accepted different filename domains.

Example: discovery loads a decision named line followed by a newline and break.md. A link to line%0Abreak.md names that same file. The old dated-filename matcher dropped the edge and kept the replaced policy active. Earlier rounds found link titles deactivating contextual decisions and fenced examples refusing valid reviews.

Choice: MarkdownDocument parses one mdast tree with mdast-util-from-markdown. mdast-util-definitions resolves used references with CommonMark’s first-definition precedence. mdast-util-to-string supplies heading text and image alt text, excluding HTML nodes. github-slugger supplies document-local heading IDs and duplicate suffixes. The unified front matter extensions exclude YAML and TOML metadata. Heading line numbers count LF characters before each node’s start offset, matching read_file and evidence citations. A lone CR separates Markdown headings but keeps them on one reader line.

Links, images, references, definitions, headings and code boundaries come from nodes. Supersedes declarations come only from paragraphs. Their text nodes supply bare filenames; link nodes supply destinations. Labels, titles, code, images and HTML nodes cannot invent edges. Formatting may span a declaration’s text. An explicit “none” or “no decision file” still suppresses contextual links.

LocalDestination resolves both kinds of destination with WHATWG URL parsing before URI decoding. Explicit URLs and network-path URLs retain their exclusion, even when they name the synthetic repository host. Relative paths retain colons, encoded delimiters and URL whitespace in filenames. Absolute path syntax is refused before applying the file base, including leading slashes, backslashes and their percent-encoded forms. Normalisation and a repository boundary check refuse escapes. Each declaring filename segment is encoded before constructing its URL base. Decision-root paths keep their established meaning.

Supersession targets share discovery’s domain: every Markdown file under docs/decisions, including nested, undated, Unicode and names containing newlines. A complete destination must name that domain and end at the Markdown extension. A newline after the extension is part of the filename, not an end anchor. A fragment selects a design file’s complete heading index; it does not validate or filter anchors. Discovery remains one hop from design.md. Public APIs and the lens prompt section remain unchanged.

What this gives up: the package carries exact-pinned grammar, definition, text, tree-visitor, front matter and slug dependencies, plus their transitive packages. Heading IDs follow GitHub’s slug rule rather than a Melian rule. HTML tags and front matter no longer contribute literal heading vocabulary. Upgrades require lockfile review and input-class tests. The small Supersedes declaration grammar remains Melian’s policy over parsed prose, rather than Markdown syntax.

The concern tables pair positive and negative cases for destination forms, fragments, references, headings, examples, metadata, filenames, revisions and bounds. Mutation checks prove each changed guard. This replaces per-round grammar patches with library contracts and explicit repository policy.
