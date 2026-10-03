import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { env } from "../env.ts";

export * as schema from "./schema.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

function connect() {
	if (env.databaseUrl) {
		const pool = new pg.Pool({ connectionString: env.databaseUrl });
		return { kind: "pg" as const, db: drizzleNodePg({ client: pool }), close: () => pool.end() };
	}
	mkdirSync(env.pgliteDir, { recursive: true });
	const client = new PGlite(env.pgliteDir);
	return { kind: "pglite" as const, db: drizzlePglite({ client }), close: () => client.close() };
}

const conn = connect();

/**
 * Both drivers share the PgAsyncDatabase query API; typing as the node-postgres flavour keeps call sites simple.
 */
export const db = conn.db as unknown as NodePgDatabase;
export type Db = typeof db;
export const dbKind = conn.kind;
export const closeDb = conn.close;

/** Applies pending migrations and idempotent backfills. Never deletes data (only `pnpm seed --reset` does). */
export async function runMigrations() {
	if (conn.kind === "pg") await migrateNodePg(conn.db, { migrationsFolder });
	else await migratePglite(conn.db as PgliteDatabase, { migrationsFolder });
	const { backfillSlugs } = await import("../lib/slug.ts");
	await backfillSlugs(db);
}
