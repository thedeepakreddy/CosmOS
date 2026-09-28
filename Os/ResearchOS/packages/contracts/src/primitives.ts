/**
 * Schema primitives shared by every contract in ResearchOS.
 *
 * Zod schemas are the single source of truth here: TypeScript types are
 * inferred from them, the OpenAPI document is generated from them, and agent
 * structured-output formats are generated from them. One definition, four
 * consumers — which is what stops the API, the database and the agent prompts
 * from drifting apart.
 */
import { z } from "zod";
import { ID_PREFIXES, type EntityKind, type Id } from "@research-os/shared";

/** Branded ID schema: validates the prefix and ULID body, and types the output. */
export function idSchema<K extends EntityKind>(kind: K) {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `Expected a ${kind} id like "${prefix}_01J…"`)
    .transform((value) => value as Id<K>);
}

/** Non-branded variant for request bodies, where the client sends a plain string. */
export function idRefSchema<K extends EntityKind>(kind: K) {
  const prefix = ID_PREFIXES[kind];
  return z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `Expected a ${kind} id`);
}

export const IsoDateTime = z.iso.datetime({ offset: true }).or(z.iso.datetime());
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** A probability or normalised score. Anything outside [0,1] is a bug, not a clamp. */
export const UnitInterval = z.number().min(0).max(1);

/** Free-form metadata that crosses a boundary. Bounded so it cannot become a dumping ground. */
export const Metadata = z.record(z.string(), z.unknown());
export type Metadata = z.infer<typeof Metadata>;

export const TenantId = z.string().min(1).max(128);

/**
 * Identifies the calling application (Echo, Aira, a future product, a third
 * party). Carried on every write so that audit logs and memory scoping can
 * answer "which product produced this?" without the core knowing what those
 * products are.
 */
export const ClientIdentity = z.object({
  /** Stable machine name of the calling application, e.g. "echo", "aira". */
  application: z.string().min(1).max(64),
  /** Optional end-user identity within that application. */
  userId: z.string().min(1).max(128).optional(),
  tenantId: TenantId.optional(),
});
export type ClientIdentity = z.infer<typeof ClientIdentity>;

export const Pagination = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  /** Opaque cursor. IDs are time-sortable, so the cursor is simply the last ID seen. */
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof Pagination>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const Citation = z.object({
  sourceId: idRefSchema("source"),
  /** Where in the source: page, section, timestamp, line range. */
  locator: z.string().max(200).optional(),
  quote: z.string().max(4000).optional(),
});
export type Citation = z.infer<typeof Citation>;

export const CITATION_STYLES = ["apa", "mla", "chicago", "ieee", "harvard", "vancouver"] as const;
export const CitationStyle = z.enum(CITATION_STYLES);
export type CitationStyle = z.infer<typeof CitationStyle>;
