import { randomUUID } from "node:crypto";

const g = globalThis as typeof globalThis & { __mpBootId?: string };
/** Random per process, so a browser can tell that a restarted app is a new one. */
export const bootId = (): string => (g.__mpBootId ??= randomUUID());
