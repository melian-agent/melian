import { PullRequestRoundHistory } from "../../src/pull-request-rounds.ts";

const { answer, member, at } = JSON.parse(process.argv[2]!);
const history = PullRequestRoundHistory.from([]);
const second = { ...member, id: "range-0123456789abcdef.r2", mintedAt: "2026-10-26T02:00:00Z" };
history.refresh(answer, [member, second], "Alice", at, false);
const legacy = { ...member, id: "range-0123456789abcdef.k0123456789abcdef", mintedAt: undefined, date: 1 };
const snapshot = history.refresh(answer, [legacy], "Alice", at, false);
process.stdout.write(JSON.stringify(snapshot.members.map((round) => round.number)));
