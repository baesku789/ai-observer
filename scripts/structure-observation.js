#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { structureObservation } from "../packages/structured-analysis/src/structure-observation.js";

const args = process.argv.slice(2);
const input = args[0];
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : null;

if (!input || (outputIndex >= 0 && !output)) {
  console.error("Usage: node scripts/structure-observation.js <raw.json> [--output structured.json]");
  process.exitCode = 1;
} else {
  const sourcePath = resolve(input);
  const raw = JSON.parse(await readFile(sourcePath, "utf8"));
  const structured = structureObservation(raw, { sourcePath });
  const text = `${JSON.stringify(structured, null, 2)}\n`;
  if (output) {
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    console.log(target);
  } else {
    process.stdout.write(text);
  }
}
