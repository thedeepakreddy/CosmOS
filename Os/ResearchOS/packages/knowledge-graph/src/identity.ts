/**
 * Deterministic node identity.
 *
 * Node ids are derived from `(projectId, type, entityId)` rather than generated
 * fresh, because the projection is rebuilt from scratch every time research
 * state changes. With random ids, every rebuild would produce a new id for the
 * same claim — and since edges reference nodes by id, every rebuild would
 * duplicate every edge. Deterministic ids make a rebuild idempotent, which is
 * what lets the store upsert instead of wiping and reinserting.
 *
 * The output still satisfies the branded `nod_<26 Crockford chars>` shape, so
 * nothing downstream has to know these are derived rather than random.
 */
import { sha256, type Id } from "@research-os/shared";
import type { GraphNodeType } from "@research-os/contracts";

/** Crockford base32 — the ULID alphabet, excluding I, L, O and U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_BODY_LENGTH = 26;

/**
 * Length-prefixes each part before hashing.
 *
 * A plain separator would let two different inputs hash to the same string if a
 * part happened to contain it. Prefixing each part with its length makes the
 * encoding unambiguous regardless of what the parts contain.
 */
function canonical(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

/** Encodes the first 130 bits of a hash as 26 Crockford base32 characters. */
function encodeBody(hashHex: string): string {
  let bits = "";
  // 26 characters x 5 bits = 130 bits = 17 bytes (the last one partially used).
  for (let i = 0; i < 17; i++) {
    const byte = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
    bits += byte.toString(2).padStart(8, "0");
  }
  let out = "";
  for (let i = 0; i < ID_BODY_LENGTH; i++) {
    const index = Number.parseInt(bits.slice(i * 5, i * 5 + 5), 2);
    out += CROCKFORD[index] ?? "0";
  }
  return out;
}

export function deterministicNodeId(projectId: string, type: GraphNodeType, entityId: string): Id<"node"> {
  return `nod_${encodeBody(sha256(canonical([projectId, type, entityId])))}` as Id<"node">;
}

export function deterministicEdgeId(projectId: string, type: string, fromNodeId: string, toNodeId: string): Id<"edge"> {
  return `edg_${encodeBody(sha256(canonical([projectId, type, fromNodeId, toNodeId])))}` as Id<"edge">;
}
