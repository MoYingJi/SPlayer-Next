#!/usr/bin/env node

import process from "node:process";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

const vendors: Record<string, { cwd: string; install?: string[]; build: string[] }> = {
  "lyric-kit": {
    cwd: path.join(rootDir, "vendor/lyric-kit"),
    install: ["pnpm", "install", "--ignore-workspace"],
    build: ["pnpm", "--ignore-workspace", "run", "build"],
  },
  "lyric-dom": {
    cwd: path.join(rootDir, "vendor/lyric-dom"),
    install: ["pnpm", "install"],
    build: ["pnpm", "run", "build"],
  },
  "applemusic-like-lyrics": {
    cwd: path.join(rootDir, "vendor/applemusic-like-lyrics"),
    install: ["pnpm", "install"],
    build: ["pnpm", "nx", "build", "core"],
  },
};

function runCmd(args: string[], cwd: string) {
  if (args.length === 0) return;
  const ret = spawnSync(args[0], args.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd,
  });
  if (ret.error) throw ret.error;
  if (ret.status !== 0) {
    process.exit(ret.status ?? 1);
  }
}

function installVendor(args: string[]) {
  for (const vendor of Object.values(vendors)) {
    if (vendor.install) {
      const lockfileArgs = args.some((arg) =>
        ["--frozen-lockfile", "--no-frozen-lockfile"].includes(arg),
      )
        ? []
        : ["--frozen-lockfile"];
      runCmd([...vendor.install, ...lockfileArgs, ...args], vendor.cwd);
    }
  }
}

function buildVendor(args: string[]) {
  for (const vendor of Object.values(vendors)) {
    runCmd([...vendor.build, ...args], vendor.cwd);
  }
}

const args = process.argv.slice(2);

switch (args[0]) {
  case "vendor":
    switch (args[1]) {
      case "install":
        installVendor(args.slice(2));
        break;
      case "build":
        buildVendor(args.slice(2));
        break;
      default:
        process.exit(1);
    }
    break;
  default:
    process.exit(1);
}
