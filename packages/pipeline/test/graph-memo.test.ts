import { expect, it } from "vitest";
import { GraphMemo } from "../src/graph-memo.ts";

it("loads each key once while it is held, even for calls that overlap", async () => {
	const memo = new GraphMemo<number>(2);
	let loads = 0;
	const load = async () => {
		loads++;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return loads;
	};
	expect(await Promise.all([memo.get("a", load), memo.get("a", load), memo.get("a", load)])).toEqual([1, 1, 1]);
	expect(loads).toBe(1);
});

it("holds at most its capacity, dropping the key used longest ago", async () => {
	const memo = new GraphMemo<string>(2);
	const loaded: string[] = [];
	const load = (key: string) => async () => {
		loaded.push(key);
		return key;
	};
	await memo.get("a", load("a"));
	await memo.get("b", load("b"));
	await memo.get("a", load("a"));
	await memo.get("c", load("c"));
	await memo.get("a", load("a"));
	await memo.get("b", load("b"));
	expect(loaded).toEqual(["a", "b", "c", "b"]);
});

it("forgets a load that failed, so the next call tries again", async () => {
	const memo = new GraphMemo<string>(2);
	await expect(memo.get("a", async () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
	expect(await memo.get("a", async () => "back")).toBe("back");
});

it("keeps a newer load of a key when an older, evicted load of it fails late", async () => {
	const memo = new GraphMemo<string>(1);
	let fail: (error: Error) => void = () => {};
	const old = memo.get("a", () => new Promise<string>((_, reject) => (fail = reject)));
	await memo.get("b", async () => "b");
	let loads = 0;
	const fresh = async () => {
		loads++;
		return "a";
	};
	await memo.get("a", fresh);
	fail(new Error("late"));
	await expect(old).rejects.toThrow("late");
	await memo.get("a", fresh);
	expect(loads).toBe(1);
});
