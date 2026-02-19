#!/usr/bin/env node
// Read account rate limits via cas (codex app-server) and print a normalized snapshot.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CasClient } from "./cas_client.mjs";
import { computeBudgetGovernor } from "./budget_governor.mjs";

const tapGovernorFormula = process.env.CAS_BUDGET_GOVERNOR_FORMULA ?? "tkersey/tap/cas-budget-governor";
const tapGovernorBinary = process.env.CAS_BUDGET_GOVERNOR_BIN ?? "cas-budget-governor";

function usage() {
  return [
    "cas_rate_limits.mjs",
    "",
    "Reads account rate limits via cas (codex app-server) and prints a normalized snapshot.",
    "",
    "Usage:",
    "  node codex/skills/cas/scripts/cas_rate_limits.mjs [options]",
    "",
    "Options:",
    "  --cwd DIR            Workspace to run in (default: current directory)",
    "  --state-file PATH    cas state file path (default: ~/.codex/cas/state/<cwd-hash>.json)",
    "  --zig                Force Zig budget governor (fallback to JS on failure)",
    "  --js                 Force JS budget governor (disable Zig)",
    "  --zig-bin PATH       Path/command for budget_governor_zig (default: local binary, then tap binary)",
    "  --json               Emit JSON to stdout",
    "  --help               Show help",
    "",
    "Notes:",
    "  - Requires `codex` on PATH (cas spawns `codex app-server`).",
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    stateFile: null,
    governor: "auto",
    zigBin: null,
    json: false,
  };

  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    if (!a) break;
    if (a === "--help" || a === "-h") return { ok: false, help: true, error: null, opts: null };

    const take = () => {
      const v = args.shift();
      if (!v) throw new Error(`Missing value for ${a}`);
      return v;
    };

    if (a === "--cwd") {
      opts.cwd = take();
      continue;
    }
    if (a === "--state-file") {
      opts.stateFile = take();
      continue;
    }
    if (a === "--zig") {
      if (opts.governor === "js") throw new Error("Cannot combine --zig and --js");
      opts.governor = "zig";
      continue;
    }
    if (a === "--js") {
      if (opts.governor === "zig") throw new Error("Cannot combine --zig and --js");
      opts.governor = "js";
      continue;
    }
    if (a === "--zig-bin") {
      opts.zigBin = take();
      continue;
    }
    if (a === "--json") {
      opts.json = true;
      continue;
    }

    throw new Error(`Unknown arg: ${a}`);
  }

  if (typeof opts.cwd !== "string" || !opts.cwd.trim()) throw new Error("--cwd must be a non-empty string");
  if (opts.stateFile !== null && (typeof opts.stateFile !== "string" || !opts.stateFile.trim())) {
    throw new Error("--state-file must be a non-empty string");
  }
  if (opts.zigBin !== null && (typeof opts.zigBin !== "string" || !opts.zigBin.trim())) {
    throw new Error("--zig-bin must be a non-empty string");
  }

  return { ok: true, help: false, error: null, opts };
}

function defaultStateFileForCwd(cwd) {
  const normalized = resolve(cwd);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return resolve(homedir(), ".codex", "cas", "state", `${digest}.json`);
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return "null";
  return `${v.toFixed(1)}%`;
}

function fmtTime(sec) {
  if (!Number.isInteger(sec)) return "null";
  return new Date(sec * 1000).toISOString();
}

function defaultZigBinaryPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "budget_governor_zig");
}

function commandAvailable(cmd, args = ["--help"]) {
  const probe = spawnSync(cmd, args, { encoding: "utf8" });
  return !probe.error;
}

function maybeInstallGovernorFromBrew() {
  if (process.platform !== "darwin") return false;
  if (!commandAvailable("brew", ["--version"])) return false;
  spawnSync("brew", ["install", tapGovernorFormula], { stdio: "ignore" });
  return commandAvailable(tapGovernorBinary, ["--help"]);
}

function resolveGovernorBinaryPath(explicitPath) {
  if (explicitPath) return explicitPath;

  const local = defaultZigBinaryPath();
  if (existsSync(local)) return local;
  if (commandAvailable(tapGovernorBinary, ["--help"])) return tapGovernorBinary;
  if (maybeInstallGovernorFromBrew()) return tapGovernorBinary;
  return local;
}

function binaryAvailable(pathOrCmd) {
  if (!pathOrCmd) return false;
  if (pathOrCmd.includes("/") || pathOrCmd.startsWith(".")) return existsSync(pathOrCmd);
  return commandAvailable(pathOrCmd, ["--help"]);
}

function computeBudgetGovernorWithZig(resp, zigBinPath) {
  if (!zigBinPath) return null;
  const result = spawnSync(zigBinPath, [], {
    input: JSON.stringify(resp),
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const text = (result.stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${usage()}\n`);
    return 2;
  }

  if (!parsed.ok) {
    if (parsed.help) {
      process.stderr.write(`${usage()}\n`);
      return 0;
    }
    process.stderr.write(`${parsed.error ?? "invalid args"}\n`);
    return 2;
  }

  const opts = parsed.opts;
  const zigBinPath = resolveGovernorBinaryPath(opts.zigBin);
  const zigBinAvailable = binaryAvailable(zigBinPath);
  const stateFile = opts.stateFile ?? defaultStateFileForCwd(opts.cwd);
  const client = new CasClient({
    cwd: opts.cwd,
    stateFile,
    clientName: "cas-rate-limits",
    clientTitle: "cas rate limits",
    clientVersion: "0.1.0",
  });

  client.on("cas/error", (ev) => {
    const detail = ev?.error ? ` detail=${JSON.stringify(ev.error)}` : "";
    process.stderr.write(`[cas] error: ${ev?.message ?? "unknown"}${detail}\n`);
  });

  try {
    await client.start();
    const resp = await client.request("account/rateLimits/read", {}, { timeoutMs: 20_000 });
    let gov = null;
    const shouldTryZig = opts.governor === "zig" || (opts.governor === "auto" && zigBinAvailable);
    if (shouldTryZig) {
      gov = computeBudgetGovernorWithZig(resp, zigBinPath);
      if (gov === null) {
        const zigReason = zigBinAvailable ? "failed" : "missing";
        process.stderr.write(
          `[cas] zig budget governor ${zigReason} at ${zigBinPath}; falling back to JS\n`,
        );
      }
    }
    if (gov === null) gov = computeBudgetGovernor(resp);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(gov, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `tier=${gov.tier} tier_reason=${gov.tierReason}`,
          `used_percent=${gov.usedPercent ?? "null"}`,
          `elapsed_percent=${fmtPct(gov.elapsedPercent)}`,
          `delta_percent=${gov.deltaPercent === null || gov.deltaPercent === undefined ? "null" : gov.deltaPercent.toFixed(1)}`,
          `resets_at=${fmtTime(gov.resetsAt)}`,
          `window_mins=${gov.windowDurationMins ?? "null"}`,
          `bucket_key=${gov.bucketKey ?? "null"}`,
          `limit_id=${gov.limitId ?? "null"}`,
          `limit_name=${gov.limitName ?? "null"}`,
          `plan_type=${gov.planType ?? "null"}`,
        ].join("\n") + "\n",
      );
    }
  } finally {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
