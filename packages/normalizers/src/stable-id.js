import { createHash } from "node:crypto";

export function stableId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

