import { closeDb, dbKind, runMigrations } from "./index.ts";

await runMigrations();
console.log(`migrations applied (${dbKind})`);
await closeDb();
