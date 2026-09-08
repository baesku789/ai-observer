#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createObservationView, structureObservation } from "../packages/structured-analysis/src/structure-observation.js";

const args = process.argv.slice(2);
const input = args[0];
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
const viewOutputIndex = args.indexOf("--view-output");
const viewOutput = viewOutputIndex >= 0 ? args[viewOutputIndex + 1] : null;

if (!input || (outputIndex >= 0 && !output) || (viewOutputIndex >= 0 && !viewOutput)) {
  console.error("Usage: node scripts/structure-observation.js <raw.json> [--output structured.json] [--view-output view.json]");
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

  if (viewOutput) {
    const viewTarget = resolve(viewOutput);
    const viewText = `${JSON.stringify(createObservationView(structured), null, 2)}\n`;
    await mkdir(dirname(viewTarget), { recursive: true });
    await writeFile(viewTarget, viewText, "utf8");
    console.log(viewTarget);
  }
}
