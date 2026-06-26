import { createHash } from "node:crypto";

export function taggedHash(tag: string, ...parts: string[]): string {
  const tagHash = createHash("sha256").update(tag).digest();
  const h = createHash("sha256").update(tagHash).update(tagHash);
  for (const part of parts) h.update(part);
  return h.digest("hex");
}

export function at<T>(arr: readonly T[], index: number): T {
  const val = arr[index];
  if (val === undefined) throw new Error(`Index ${index} out of bounds`);
  return val;
}

export const MAX_SIDES = 2 ** 48;
