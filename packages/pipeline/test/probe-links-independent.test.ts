import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { Probe, ProbeError, type ProbeOptions } from "../src/probe.ts";

// An independent check of the rule in docs/decisions/2026-11-07-probes-run-under-sandbox-runtime.md: a head whose tracked
// links leave the tree, reach its root, or reach a node_modules is refused before setup writes through them.

const original = process.env.TMPDIR;
let base: string;
let checkout: string;
let outside: string;

const sandbox = {
	platform: "linux" as const,
	unavailable: () => undefined,
	open: async () => {},
	wrap: async (command: string) => ["/bin/bash", "-c", command],
	cleanup: () => {},
	close: async () => {},
};

// Whether this filesystem opens `spelling` as an existing `node_modules`, as APFS does for `NODE_MODULES`.
function aliasesNodeModules(spelling: string): boolean {
	const at = mkdtempSync(join(original ?? tmpdir(), "melian-alias-"));
	try {
		mkdirSync(join(at, "node_modules"));
		return existsSync(join(at, spelling));
	} finally {
		rmSync(at, { recursive: true, force: true });
	}
}

const caseInsensitive = aliasesNodeModules("NODE_MODULES");

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(original ?? tmpdir(), "melian-links-")));
	process.env.TMPDIR = base;
	checkout = join(base, "checkout");
	outside = join(base, "outside");
	mkdirSync(checkout);
	mkdirSync(outside);
	writeFileSync(join(outside, "canary.txt"), "canary\n");
	gitIn(checkout, "init", "--quiet", "--initial-branch=main");
});

afterEach(() => {
	process.env.TMPDIR = original;
	if (original === undefined) delete process.env.TMPDIR;
	rmSync(base, { recursive: true, force: true });
});

// Builds the head with `make`, commits it, and returns the commit.
function headWith(make: (at: string) => void): string {
	make(checkout);
	gitIn(checkout, "add", "--all");
	gitIn(checkout, "commit", "--quiet", "--allow-empty", "-m", "head");
	return gitIn(checkout, "rev-parse", "HEAD");
}

function options(commit: string, read?: readonly string[]): ProbeOptions {
	return {
		head: read === undefined ? { checkout, commit } : { checkout, commit, read },
		writer: { trusted: true, by: "writer" },
		trustWriters: true,
		sandbox,
	};
}

type Outcome =
	| { readonly accepted: true; readonly tree: string }
	| { readonly accepted: false; readonly code: string; readonly message: string };

async function outcome(commit: string, read?: readonly string[]): Promise<Outcome> {
	try {
		const probe = await Probe.open({ script: "" }, options(commit, read));
		const tree = probe.policy.read[0]!;
		probes.push(probe);
		return { accepted: true, tree };
	} catch (error) {
		if (!(error instanceof ProbeError)) throw error;
		return { accepted: false, code: error.code, message: error.message };
	}
}

const probes: Probe[] = [];
afterEach(async () => {
	for (const probe of probes.splice(0)) await probe.close();
});

const refused = (path: string) => ({
	accepted: false,
	code: "invalidProbe",
	message: `the head's link ${path} leads outside its tree or into its node_modules`,
});

// Neither the scratch nor the temporary repository survives a refusal, and the host directory is untouched.
function nothingLeft(): void {
	expect(readdirSync(base).sort()).toEqual(["checkout", "outside"]);
	expect(readdirSync(outside)).toEqual(["canary.txt"]);
	expect(readFileSync(join(outside, "canary.txt"), "utf8")).toBe("canary\n");
}

describe("relative links through ..", () => {
	it.each([
		["one level out", "l", ".."],
		["one level out to a sibling", "l", "../outside"],
		["three levels out from a nested directory", "a/b/c/l", "../../../../outside/canary.txt"],
		["out and back in by name", "a/l", "../../checkout/a"],
		["far past the filesystem root", "l", "../../../../../../../../../../../../../.."],
	])("refuses %s", async (_, path, target) => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "a", "b", "c"), { recursive: true });
			writeFileSync(join(at, "a", "keep.txt"), "kept\n");
			symlinkSync(target, join(at, path));
		});
		expect(await outcome(commit)).toEqual(refused(path));
		nothingLeft();
	});

	it("accepts a nested link that climbs to a sibling inside the tree", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "a", "b", "c"), { recursive: true });
			mkdirSync(join(at, "x"));
			writeFileSync(join(at, "x", "file.txt"), "x\n");
			symlinkSync("../../../x/file.txt", join(at, "a", "b", "c", "l"));
		});
		const result = await outcome(commit);
		expect(result.accepted).toBe(true);
		if (result.accepted) expect(readFileSync(join(result.tree, "a", "b", "c", "l"), "utf8")).toBe("x\n");
	});
});

describe("absolute links", () => {
	it.each([
		["a host directory", () => outside],
		["a host file", () => join(outside, "canary.txt")],
		["the filesystem root", () => "/"],
		["the checkout's own working tree", () => checkout],
		["a path that does not exist", () => join(base, "missing", "x")],
	])("refuses a link to %s", async (_, target) => {
		const commit = headWith((at) => symlinkSync(target(), join(at, "l")));
		expect(await outcome(commit)).toEqual(refused("l"));
		nothingLeft();
	});
});

describe("links to the root and above it", () => {
	it.each([
		["a link to .", "l", "."],
		["a link to ./", "l", "./"],
		["a link to .//.", "l", ".//."],
		["a nested link to ..", "sub/l", ".."],
		["a nested link to ../.", "sub/l", "../."],
		["a link to the root's parent", "l", ".."],
		["a nested link to the root's parent", "sub/l", "../.."],
	])("refuses %s", async (_, path, target) => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "sub"));
			writeFileSync(join(at, "sub", "keep.txt"), "kept\n");
			symlinkSync(target, join(at, path));
		});
		expect(await outcome(commit)).toEqual(refused(path));
		nothingLeft();
	});
});

describe("chains of links", () => {
	// Folding `..` textually reads x/y/a -> l/../.. as x, inside; the kernel follows l to s first, so a reaches the root's
	// parent.
	it("refuses a link whose .. climbs from where another link leads, though both read as inside", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "x", "y"), { recursive: true });
			mkdirSync(join(at, "s"));
			writeFileSync(join(at, "s", "keep.txt"), "kept\n");
			symlinkSync("../../s", join(at, "x", "y", "l"));
			symlinkSync("l/../..", join(at, "x", "y", "a"));
		});
		expect(await outcome(commit)).toEqual(refused(join("x", "y", "a")));
		nothingLeft();
	});

	it("refuses a three-link chain whose last hop climbs out", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "p", "q"), { recursive: true });
			mkdirSync(join(at, "s"));
			writeFileSync(join(at, "s", "keep.txt"), "kept\n");
			symlinkSync("../../s", join(at, "p", "q", "one"));
			symlinkSync("one", join(at, "p", "q", "two"));
			symlinkSync("two/../../outside", join(at, "p", "q", "three"));
		});
		expect(await outcome(commit)).toEqual(refused(join("p", "q", "three")));
		nothingLeft();
	});

	it("accepts a chain that ends inside", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "s"));
			writeFileSync(join(at, "s", "file.txt"), "end\n");
			symlinkSync("s", join(at, "one"));
			symlinkSync("one/file.txt", join(at, "two"));
			symlinkSync("two", join(at, "three"));
		});
		const result = await outcome(commit);
		expect(result.accepted).toBe(true);
		if (result.accepted) expect(readFileSync(join(result.tree, "three"), "utf8")).toBe("end\n");
	});
});

describe("links through a tracked directory link", () => {
	function withDirectoryLink(target: string): string {
		return headWith((at) => {
			mkdirSync(join(at, "real", "deep"), { recursive: true });
			writeFileSync(join(at, "real", "deep", "file.txt"), "deep\n");
			symlinkSync("real/deep", join(at, "d"));
			symlinkSync(target, join(at, "l"));
		});
	}

	it("accepts a link to the directory link and through it to a file", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "real"));
			writeFileSync(join(at, "real", "file.txt"), "real\n");
			symlinkSync("real", join(at, "d"));
			symlinkSync("d", join(at, "l"));
			symlinkSync("d/file.txt", join(at, "f"));
		});
		const result = await outcome(commit);
		expect(result.accepted).toBe(true);
		if (result.accepted) expect(readFileSync(join(result.tree, "f"), "utf8")).toBe("real\n");
	});

	// The kernel reads d/.. as real, not as the root, so d/../.. is the root.
	it("refuses d/../.., which reaches the root through d", async () => {
		expect(await outcome(withDirectoryLink("d/../.."))).toEqual(refused("l"));
		nothingLeft();
	});

	it("refuses d/../../.., which leaves through d", async () => {
		expect(await outcome(withDirectoryLink("d/../../.."))).toEqual(refused("l"));
		nothingLeft();
	});

	it("accepts d/.., which the kernel reads as real", async () => {
		const result = await outcome(withDirectoryLink("d/.."));
		expect(result.accepted).toBe(true);
		if (result.accepted) expect(readFileSync(join(result.tree, "l", "deep", "file.txt"), "utf8")).toBe("deep\n");
	});
});

describe("links into node_modules spelled another way", () => {
	it.each([
		["through a directory and ..", "a/../node_modules/x"],
		["through a missing directory and ..", "missing/../node_modules/x"],
		["with a ./ prefix", "./node_modules/x"],
		["with doubled slashes", "a//..//node_modules"],
		["through a link to a directory", "d/../node_modules/x"],
		["to a nested node_modules", "a/node_modules"],
	])("refuses a link into node_modules %s", async (_, target) => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "a"));
			writeFileSync(join(at, "a", "keep.txt"), "kept\n");
			symlinkSync("a", join(at, "d"));
			symlinkSync(target, join(at, "l"));
		});
		expect(await outcome(commit)).toEqual(refused("l"));
		nothingLeft();
	});

	it("refuses a link into a node_modules the head tracks", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "node_modules", "x"), { recursive: true });
			writeFileSync(join(at, "node_modules", "x", "index.js"), "tracked\n");
			symlinkSync("node_modules/x", join(at, "l"));
		});
		expect(await outcome(commit)).toEqual(refused("l"));
	});
});

describe("names differing in letter case", () => {
	// On a case-insensitive filesystem, NODE_MODULES is the node_modules that dependency linking creates after the walk.
	it("refuses a dangling link to NODE_MODULES where the filesystem folds case", async () => {
		const commit = headWith((at) => symlinkSync("NODE_MODULES/x", join(at, "l")));
		const result = await outcome(commit);
		if (caseInsensitive) expect(result).toEqual(refused("l"));
		else expect(result.accepted).toBe(true);
	});

	it("refuses a link to a tracked node_modules spelled NODE_MODULES where the filesystem folds case", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "node_modules", "x"), { recursive: true });
			writeFileSync(join(at, "node_modules", "x", "index.js"), "tracked\n");
			symlinkSync("NODE_MODULES/x", join(at, "l"));
		});
		const result = await outcome(commit);
		if (caseInsensitive) expect(result).toEqual(refused("l"));
		else expect(result.accepted).toBe(true);
	});

	it("refuses a link to node_moduleſ (long s) where the filesystem folds it to node_modules", async () => {
		const commit = headWith((at) => symlinkSync("node_moduleſ/x", join(at, "l")));
		const result = await outcome(commit);
		if (aliasesNodeModules("node_moduleſ")) expect(result).toEqual(refused("l"));
		else expect(result.accepted).toBe(true);
	});

	// The workspace's tracked link reads as inside, and dependency linking then makes its node_modules through it, which
	// lands in the reviewer's install on a case-insensitive filesystem.
	it.runIf(caseInsensitive)(
		"writes nothing into the reviewer's install through a workspace linked to NODE_MODULES",
		async () => {
			const commit = headWith((at) => {
				mkdirSync(join(at, "packages"));
				symlinkSync("../NODE_MODULES/dep", join(at, "packages", "foo"));
				writeFileSync(join(at, ".gitignore"), "node_modules\n");
			});
			unlinkSync(join(checkout, "packages", "foo"));
			mkdirSync(join(checkout, "packages", "foo", "node_modules", "inner"), { recursive: true });
			mkdirSync(join(checkout, "node_modules", "dep"), { recursive: true });
			writeFileSync(join(checkout, "node_modules", "dep", "index.js"), "install\n");
			symlinkSync("../packages/foo", join(checkout, "node_modules", "foo"));
			const result = await outcome(commit);
			const install = readdirSync(join(checkout, "node_modules", "dep")).sort();
			expect({ result, install }).toEqual({ result: refused(join("packages", "foo")), install: ["index.js"] });
		},
	);

	it("refuses a head tracking a link and a directory whose names differ only in case, and writes nothing outside", async () => {
		const commit = headWith(() => {});
		// The tree holds the link `D` beside a real directory `d`, built from objects, since this working tree cannot hold
		// both on a case-insensitive filesystem.
		const tree = mixedCaseTree();
		const mixed = gitIn(checkout, "commit-tree", tree, "-p", commit, "-m", "mixed");
		const result = await outcome(mixed);
		expect(result.accepted).toBe(false);
		if (!result.accepted) {
			expect(result.code).toBe("invalidProbe");
			if (caseInsensitive) expect(result.message).toMatch(/could not be written/);
			else expect(result.message).toBe(refused("D").message);
		}
		nothingLeft();
	});
});

// A tree holding the link `D -> outside` and the file `d/x.txt`.
function mixedCaseTree(): string {
	const link = gitHash(outside);
	const file = gitHash("written through the link\n");
	const inner = gitInput(`100644 blob ${file}\tx.txt\n`, "mktree");
	return gitInput(`120000 blob ${link}\tD\n040000 tree ${inner}\td\n`, "mktree");
}

function gitHash(content: string): string {
	return gitInput(content, "hash-object", "-w", "--stdin");
}

function gitInput(input: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: checkout,
		input,
		encoding: "utf8",
		env: { ...process.env, ...isolatedGitEnv },
	}).trim();
}

describe("Unicode names", () => {
	const composed = "café";
	const decomposed = "café";

	it("refuses a composed link name that climbs out through a decomposed directory", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, decomposed));
			writeFileSync(join(at, decomposed, "keep.txt"), "kept\n");
			symlinkSync(`${composed}/../..`, join(at, "l"));
		});
		expect(await outcome(commit)).toEqual(refused("l"));
		nothingLeft();
	});

	it("accepts a composed link into a decomposed directory", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, decomposed));
			writeFileSync(join(at, decomposed, "file.txt"), "unicode\n");
			symlinkSync(`${composed}/file.txt`, join(at, "l"));
		});
		const result = await outcome(commit);
		expect(result.accepted).toBe(true);
	});

	it("refuses a head with a decomposed link out and a composed directory, and writes nothing outside", async () => {
		const link = gitHash(outside);
		const file = gitHash("written through the link\n");
		const inner = gitInput(`100644 blob ${file}\tx.txt\n`, "mktree");
		const tree = gitInput(`120000 blob ${link}\t${decomposed}\n040000 tree ${inner}\t${composed}\n`, "mktree");
		const commit = gitInput("", "commit-tree", tree, "-m", "unicode");
		const result = await outcome(commit);
		expect(result.accepted).toBe(false);
		if (!result.accepted) expect(result.code).toBe("invalidProbe");
		nothingLeft();
	});
});

describe("gitlinks", () => {
	function withGitlink(path: string, more: (at: string) => void = () => {}): string {
		more(checkout);
		gitIn(checkout, "add", "--all");
		gitIn(checkout, "commit", "--quiet", "--allow-empty", "-m", "base");
		gitIn(checkout, "update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},${path}`);
		gitIn(checkout, "commit", "--quiet", "-m", "gitlink");
		return gitIn(checkout, "rev-parse", "HEAD");
	}

	it("accepts a gitlink and leaves it an empty directory", async () => {
		const result = await outcome(withGitlink("sub"));
		expect(result.accepted).toBe(true);
		if (result.accepted) expect(readdirSync(join(result.tree, "sub"))).toEqual([]);
	});

	it("refuses a link that climbs out through a gitlink's directory", async () => {
		const commit = withGitlink("sub", (at) => symlinkSync("sub/../..", join(at, "l")));
		expect(await outcome(commit)).toEqual(refused("l"));
		nothingLeft();
	});

	it("accepts a link into a gitlink's empty directory", async () => {
		const commit = withGitlink("sub", (at) => symlinkSync("sub/file", join(at, "l")));
		expect((await outcome(commit)).accepted).toBe(true);
	});
});

describe("missing git objects", () => {
	function dropObject(hash: string): void {
		unlinkSync(join(checkout, ".git", "objects", hash.slice(0, 2), hash.slice(2)));
	}

	it("refuses a head whose file blob is missing", async () => {
		const commit = headWith((at) => writeFileSync(join(at, "file.txt"), "gone\n"));
		dropObject(gitIn(checkout, "rev-parse", "HEAD:file.txt"));
		const result = await outcome(commit);
		expect(result).toMatchObject({ accepted: false, code: "invalidProbe" });
		nothingLeft();
	});

	it("refuses a head whose link blob is missing", async () => {
		const commit = headWith((at) => {
			writeFileSync(join(at, "file.txt"), "kept\n");
			symlinkSync(outside, join(at, "l"));
		});
		dropObject(gitIn(checkout, "rev-parse", "HEAD:l"));
		const result = await outcome(commit);
		expect(result).toMatchObject({ accepted: false, code: "invalidProbe" });
		nothingLeft();
	});

	it("refuses a head whose tree object is missing", async () => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "dir"));
			writeFileSync(join(at, "dir", "file.txt"), "kept\n");
		});
		dropObject(gitIn(checkout, "rev-parse", "HEAD:dir"));
		const result = await outcome(commit);
		expect(result).toMatchObject({ accepted: false, code: "invalidProbe" });
		nothingLeft();
	});

	it("refuses a commit the checkout does not hold", async () => {
		headWith((at) => writeFileSync(join(at, "file.txt"), "kept\n"));
		const result = await outcome("0123456789abcdef0123456789abcdef01234567");
		expect(result).toMatchObject({ accepted: false, code: "invalidProbe" });
		nothingLeft();
	});
});

describe("dangling links that stay inside", () => {
	it.each([
		["a missing file", "missing.txt"],
		["a missing nested path", "missing/deeper/file"],
		["a path under a regular file", "file.txt/x"],
		["a .. before the missing component", "sub/../missing"],
	])("accepts a link to %s", async (_, target) => {
		const commit = headWith((at) => {
			mkdirSync(join(at, "sub"));
			writeFileSync(join(at, "sub", "keep.txt"), "kept\n");
			writeFileSync(join(at, "file.txt"), "file\n");
			symlinkSync(target, join(at, "l"));
		});
		const result = await outcome(commit);
		expect(result).toEqual({ accepted: true, tree: expect.any(String) });
		if (result.accepted) expect(readlinkSync(join(result.tree, "l"))).toBe(target);
	});
});

describe("the allowlist's copies", () => {
	it("refuses a copied directory whose link reaches NODE_MODULES where the filesystem folds case", async () => {
		const commit = headWith((at) => writeFileSync(join(at, "tracked.txt"), "tracked\n"));
		mkdirSync(join(checkout, "generated"));
		symlinkSync("../NODE_MODULES/x", join(checkout, "generated", "l"));
		const result = await outcome(commit, ["generated"]);
		if (caseInsensitive) expect(result).toEqual(refused(join("generated", "l")));
		else expect(result.accepted).toBe(true);
	});
});
