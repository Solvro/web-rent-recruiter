import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../env.ts";

/** Demo portraits shipped with the app (app/public/avatars, served as /avatars/<file>). Name → URL path. */
const manifestPath = resolve(env.repoRoot, "app/public/avatars/manifest.json");
const AVATARS = (existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {}) as Record<
	string,
	string
>;

export const demoAvatar = (name: string): string | null => AVATARS[name.trim()] ?? null;
