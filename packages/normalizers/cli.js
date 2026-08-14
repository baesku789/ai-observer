#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeObservation } from "./src/index.js";

const args = process.argv.slice(2);
const input = args[0];
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
if (!input) {
  console.error("Usage: node packages/normalizers/cli.js <raw.json> [--output normalized.json]");
  process.exitCode = 1;
} else {
  const raw = JSON.parse(await readFile(resolve(input), "utf8"));
  const normalized = normalizeObservation(raw);
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  if (output) {
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    console.log(target);
  } else process.stdout.write(text);
}

