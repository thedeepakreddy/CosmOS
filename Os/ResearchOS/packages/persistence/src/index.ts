/**
 * @research-os/persistence — storage ports and adapters.
 *
 * PostgreSQL is the production target; SQLite (via Node's built-in driver) is
 * the zero-infrastructure local path. One set of migrations drives both.
 */
export * from "./dialect.ts";
export * from "./database.ts";
export * from "./config.ts";
export * from "./sqlite-database.ts";
export * from "./postgres-database.ts";
export * from "./migrator.ts";
export * from "./row.ts";
export { MIGRATIONS, type Migration } from "./migrations/index.ts";
export * from "./repositories/index.ts";
export * from "./store.ts";
