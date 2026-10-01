#!/usr/bin/env node

import process from "node:process";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

const vendors: Record<string, { cwd: string; install?: string[]; build: string[] }> = {
  "lyric-kit": {
    cwd: path.join(rootDir, "vendor/lyric-kit"),
    install: ["install", "--ignore-workspace"],
    build: ["--ignore-workspace", "run", "build"],
  },
  "lyric-dom": {
    cwd: path.join(rootDir, "vendor/lyric-dom"),
    install: ["install"],
    build: ["run", "build"],
  },
  "applemusic-like-lyrics": {
    cwd: path.join(rootDir, "vendor/applemusic-like-lyrics"),
    install: ["install"],
    build: ["--filter", "@applemusic-like-lyrics/core", "build"],
  },
};

function run_cmd(args: string[], cwd: string) {
  const ret = spawnSync("pnpm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd,
  });
  if (ret.error) throw ret.error;
  if (ret.status !== 0) {
    process.exit(ret.status ?? 1);
  }
}

function install_vendor(args: string[]) {
  for (const vendor of Object.values(vendors)) {
    if (vendor.install) {
      const lockfileArgs = args.some((arg) =>
        ["--frozen-lockfile", "--no-frozen-lockfile"].includes(arg),
      )
        ? []
        : ["--frozen-lockfile"];
      run_cmd([...vendor.install, ...lockfileArgs, ...args], vendor.cwd);
    }
  }
}

function build_vendor(args: string[]) {
  for (const vendor of Object.values(vendors)) {
    run_cmd([...vendor.build, ...args], vendor.cwd);
  }
}

const args = process.argv.slice(2);

switch (args[0]) {
  case "vendor":
    switch (args[1]) {
      case "install":
        install_vendor(args.slice(2));
        break;
      case "build":
        build_vendor(args.slice(2));
        break;
      default:
        process.exit(1);
    }
    break;
  default:
    process.exit(1);
}
