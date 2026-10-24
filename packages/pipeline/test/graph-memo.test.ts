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
