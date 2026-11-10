#!/usr/bin/env node

/**
 * Verify the npm artifact contains only the built runtime and can be imported
 * without the monorepo's workspace dependencies. This test never publishes
 * and writes its temporary tarball/extract into an OS temporary directory.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const packageRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "costkey-sdk-pack-"));

try {
  const dryRun = parsePackReport(await exec("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot }));
  const dryFiles = dryRun.files;
  const forbidden = dryFiles.filter((file) =>
    /(^|\/)(__tests__|benchmarks)(\/|$)|\.test\.(?:js|d\.ts|map)$/.test(file.path),
  );
  if (forbidden.length > 0) {
    throw new Error(`published package contains test/benchmark files: ${forbidden.map((file) => file.path).join(", ")}`);
  }

  const packDestination = join(temporaryRoot, "packed");
  await mkdir(packDestination);
  const packed = parsePackReport(await exec("npm", ["pack", "--json", "--pack-destination", packDestination], { cwd: packageRoot }));
  const tarball = join(packDestination, packed.filename);
  await exec("tar", ["-xzf", tarball, "-C", temporaryRoot]);

  const packageDirectory = join(temporaryRoot, "package");
  const runtimeEntry = join(packageDirectory, "dist", "index.js");
  const loaded = await import(`${pathToFileURL(runtimeEntry).href}?pack-check=${Date.now()}`);
  if (!loaded.CostKey || typeof loaded.CostKey.init !== "function" || !loaded.Provider) {
    throw new Error("packed runtime did not expose CostKey and Provider");
  }

  const distFiles = await listFiles(join(packageDirectory, "dist"));
  const privateImports = [];
  for (const relative of distFiles.filter((file) => /\.(?:js|d\.ts|js\.map|d\.ts\.map)$/.test(file))) {
    const source = await readFile(join(packageDirectory, "dist", relative), "utf8");
    if (source.includes("@costkey/shared")) privateImports.push(`dist/${relative}`);
  }
  if (privateImports.length > 0) {
    throw new Error(`packed declarations/runtime import private workspace package: ${privateImports.join(", ")}`);
  }

  process.stdout.write(`${JSON.stringify({
    package: packed.id,
    entryCount: dryFiles.length,
    unpackedSize: packed.unpackedSize,
    testsOrBenchmarks: 0,
    runtimeImport: true,
    privateImports: 0,
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parsePackReport(result) {
  const text = result.stdout.trim();
  const start = text.indexOf("[");
  if (start < 0) throw new Error(`npm pack did not return JSON: ${text.slice(0, 200)}`);
  const report = JSON.parse(text.slice(start));
  const first = Array.isArray(report) ? report[0] : report;
  if (!first || typeof first !== "object" || !Array.isArray(first.files)) {
    throw new Error("npm pack JSON report did not include files");
  }
  return first;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const nested of await listFiles(join(directory, entry.name))) files.push(join(entry.name, nested));
    } else {
      files.push(entry.name);
    }
  }
  return files;
}
