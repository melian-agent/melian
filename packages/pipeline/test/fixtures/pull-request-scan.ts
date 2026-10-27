import { backgroundContext, createMemoryStorage } from "../../src/harness.ts";
import { MembershipReader } from "../../src/pull-request-rounds.ts";

const storage = createMemoryStorage();
const rounds = await MembershipReader.open(storage).candidates("range-0123456789abcdef");
await storage.close(backgroundContext);
process.stdout.write(JSON.stringify(rounds));
