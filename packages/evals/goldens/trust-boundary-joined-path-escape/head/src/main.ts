import { postComment } from "./github.ts";
import { summarise } from "./summary.ts";

const checkout = process.argv[2]!;
await postComment(await summarise(checkout));
