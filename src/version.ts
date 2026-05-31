/** @desc Package version — single source of truth aligned with package.json */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
) as { version: string };

/** Semver version string, sourced from package.json at import time. */
export const VERSION: string = pkg.version;
