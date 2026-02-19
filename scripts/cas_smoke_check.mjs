#!/usr/bin/env node
// Zig-first launcher for cas_smoke_check with Homebrew tap bootstrap and JS fallback.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const zigBinary = resolve(here, "cas_smoke_check_zig");
const zigSource = resolve(here, "cas_smoke_check.zig");
const legacyScript = resolve(here, "cas_smoke_check_legacy.mjs");
const tapFormula = process.env.CAS_SMOKE_CHECK_FORMULA ?? "tkersey/tap/cas-smoke-check";
const tapBinary = process.env.CAS_SMOKE_CHECK_BIN ?? "cas-smoke-check";
const helpMarker = "cas_smoke_check.zig";

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}

function commandAvailable(cmd, args = ["--help"], marker = null) {
  const res = run(cmd, args);
  if (res.error) return false;
  if (!marker) return true;
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  return text.includes(marker);
}

function maybeInstallFromBrew() {
  if (process.platform !== "darwin") return false;
  if (!commandAvailable("brew", ["--version"])) return false;
  run("brew", ["install", tapFormula], { stdio: "ignore" });
  return commandAvailable(tapBinary, ["--help"], helpMarker);
}

function resolveZigExecution() {
  if (commandAvailable(tapBinary, ["--help"], helpMarker)) {
    return { cmd: tapBinary, args: [] };
  }
  if (maybeInstallFromBrew()) {
    return { cmd: tapBinary, args: [] };
  }
  if (existsSync(zigBinary)) {
    return { cmd: zigBinary, args: [] };
  }
  if (commandAvailable("zig", ["version"])) {
    return { cmd: "zig", args: ["run", zigSource, "--"] };
  }
  return null;
}

function execWithArgs(target, argv) {
  const result = run(target.cmd, [...target.args, ...argv], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Fatal: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  const argv = process.argv.slice(2);
  const target = resolveZigExecution();
  if (target) return execWithArgs(target, argv);

  if (!existsSync(legacyScript)) {
    process.stderr.write("Fatal: no Zig runtime and legacy fallback script missing.\n");
    return 1;
  }
  return execWithArgs({ cmd: process.execPath, args: [legacyScript] }, argv);
}

process.exit(main());
