"use strict";

// Copies the InsuranceWebsite frontend files (the sibling repo) into this
// server's `public/` folder, so InsuranceServer serves a fresh snapshot of the
// live website. Override the source directory with the WEB_SRC env variable.

const fs = require("node:fs");
const path = require("node:path");

const SRC = process.env.WEB_SRC || path.join(__dirname, "..", "InsuranceWebsite");
const DEST = path.join(__dirname, "public");

// Files/dirs that belong to standalone static hosting or tooling, not to the
// website bundle served by InsuranceServer.
const SKIP = new Set([
  ".git",
  ".vscode",
  "node_modules",
  "package.json",
  "package-lock.json",
  "server.js",
  ".gitignore",
]);

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Source website directory not found: ${SRC}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(DEST, { recursive: true });

  // Remove stale top-level files from the previous sync so files deleted from
  // the website don't linger (which is exactly the "showing the old version"
  // problem).
  for (const name of fs.readdirSync(DEST)) {
    const p = path.join(DEST, name);
    if (fs.statSync(p).isFile()) fs.unlinkSync(p);
  }

  let copied = 0;
  for (const name of fs.readdirSync(SRC)) {
    const srcPath = path.join(SRC, name);
    if (!fs.statSync(srcPath).isFile()) continue; // only top-level files
    if (SKIP.has(name)) continue;
    fs.copyFileSync(srcPath, path.join(DEST, name));
    copied += 1;
  }

  console.log(`Synced ${copied} file(s) from "${SRC}" to "${DEST}".`);
}

main();
