import { Install } from "../../src/installed-packages.ts";

process.stdout.write(Install.read(process.argv[2]!).digest);
