import { installedPackagesDigest } from "../../src/installed-packages.ts";

process.stdout.write(installedPackagesDigest(JSON.parse(process.argv[2]!)));
