/**
 * Migration registry.
 *
 * Migrations are TypeScript modules rather than `.sql` files because the same
 * migration has to emit valid DDL for two engines. A function taking the
 * dialect keeps one authoritative definition of the schema; two parallel SQL
 * directories would drift the first time someone edited only one of them.
 */
import type { SqlDialect } from "../dialect.ts";
import * as initial from "./001-initial-schema.ts";

export interface Migration {
  readonly id: string;
  up(dialect: SqlDialect): string[];
}

/** Ordered. Never reorder or edit a shipped migration — add a new one. */
export const MIGRATIONS: readonly Migration[] = [initial];
