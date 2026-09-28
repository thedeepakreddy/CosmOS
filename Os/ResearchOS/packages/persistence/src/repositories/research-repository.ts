/**
 * Sources, evidence, claims and contradictions.
 *
 * Grouped into one repository because they are written together inside single
 * transactions — ingesting a source writes its document and chunks, and scoring
 * a claim reads its evidence and its sources. Splitting them would mean either
 * leaking transaction handles across repositories or losing atomicity.
 */
import type {
  Claim,
  ClaimEvidenceLink,
  ClaimRelation,
  Contradiction,
  Evidence,
  Source,
  SourceChunk,
  SourceDocument,
  SourceStatus,
} from "@research-os/contracts";
import type { Database } from "../database.ts";
import { asEntity, boolOrNull, json, jsonOrNull, num, numOrNull, str, strOrNull, toJson, type Row } from "../row.ts";

function toSource(row: Row): Source {
  return asEntity<Source>({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    url: strOrNull(row, "url"),
    doi: strOrNull(row, "doi"),
    title: str(row, "title"),
    authors: json(row, "authors", []),
    publisher: strOrNull(row, "publisher"),
    publishedAt: strOrNull(row, "published_at"),
    sourceType: str(row, "source_type"),
    status: str(row, "status"),
    domain: strOrNull(row, "domain"),
    contentHash: strOrNull(row, "content_hash"),
    storageKey: strOrNull(row, "storage_key"),
    retrievedAt: strOrNull(row, "retrieved_at"),
    quality: jsonOrNull(row, "quality"),
    discoveredBy: strOrNull(row, "discovered_by"),
    failureReason: strOrNull(row, "failure_reason"),
    metadata: json(row, "metadata", {}),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  });
}

function toEvidence(row: Row): Evidence {
  return asEntity<Evidence>({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    sourceId: str(row, "source_id"),
    chunkIds: json(row, "chunk_ids", []),
    quote: str(row, "quote"),
    locator: strOrNull(row, "locator"),
    interpretation: str(row, "interpretation"),
    stance: str(row, "stance"),
    strength: json(row, "strength", {}),
    relevance: num(row, "relevance"),
    extractedByRunId: strOrNull(row, "extracted_by_run_id"),
    verifiedAt: strOrNull(row, "verified_at"),
    verificationPassed: boolOrNull(row, "verification_passed"),
    createdAt: str(row, "created_at"),
  });
}

function toClaim(row: Row): Claim {
  return asEntity<Claim>({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    questionId: strOrNull(row, "question_id"),
    hypothesisId: strOrNull(row, "hypothesis_id"),
    statement: str(row, "statement"),
    scope: strOrNull(row, "scope"),
    claimType: str(row, "claim_type"),
    status: str(row, "status"),
    assumptions: json(row, "assumptions", []),
    confidence: jsonOrNull(row, "confidence"),
    proposedByRunId: strOrNull(row, "proposed_by_run_id"),
    supersededByClaimId: strOrNull(row, "superseded_by_claim_id"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  });
}

function toContradiction(row: Row): Contradiction {
  return asEntity<Contradiction>({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    claimIdA: str(row, "claim_id_a"),
    claimIdB: str(row, "claim_id_b"),
    kind: str(row, "kind"),
    status: str(row, "status"),
    description: str(row, "description"),
    severity: num(row, "severity"),
    candidateExplanations: json(row, "candidate_explanations", []),
    resolution: strOrNull(row, "resolution"),
    resolvedByRunId: strOrNull(row, "resolved_by_run_id"),
    detectedByRunId: strOrNull(row, "detected_by_run_id"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  });
}

export class ResearchRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /* ---------- Sources ---------- */

  /**
   * Inserts a source unless its content hash already exists in the project.
   * Returns the existing row when it does — discovery paths overlap constantly,
   * and the same paper found twice must not become two sources with two votes.
   */
  async upsertSource(source: Source): Promise<{ source: Source; created: boolean }> {
    if (source.contentHash) {
      const existing = await this.#db.queryOne<Row>(
        "SELECT * FROM sources WHERE project_id = ? AND content_hash = ?",
        [source.projectId, source.contentHash],
      );
      if (existing) return { source: toSource(existing), created: false };
    }
    if (source.url) {
      const existing = await this.#db.queryOne<Row>(
        "SELECT * FROM sources WHERE project_id = ? AND url = ?",
        [source.projectId, source.url],
      );
      if (existing) return { source: toSource(existing), created: false };
    }

    await this.#db.execute(
      `INSERT INTO sources (id, project_id, url, doi, title, authors, publisher, published_at, source_type, status,
        domain, content_hash, storage_key, retrieved_at, quality, quality_score, discovered_by, failure_reason,
        metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.id, source.projectId, source.url, source.doi, source.title, toJson(source.authors), source.publisher,
        source.publishedAt, source.sourceType, source.status, source.domain, source.contentHash, source.storageKey,
        source.retrievedAt, toJson(source.quality), source.quality?.score ?? null, source.discoveredBy,
        source.failureReason, toJson(source.metadata), source.createdAt, source.updatedAt,
      ],
    );
    return { source, created: true };
  }

  async findSource(id: string): Promise<Source | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM sources WHERE id = ?", [id]);
    return row ? toSource(row) : undefined;
  }

  async listSources(projectId: string, options: { status?: SourceStatus; limit?: number; cursor?: string } = {}): Promise<Source[]> {
    const conditions = ["project_id = ?"];
    const params: (string | number)[] = [projectId];
    if (options.status) { conditions.push("status = ?"); params.push(options.status); }
    if (options.cursor) { conditions.push("id < ?"); params.push(options.cursor); }
    params.push(options.limit ?? 200);
    const rows = await this.#db.query<Row>(`SELECT * FROM sources WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, params);
    return rows.map(toSource);
  }

  async findSourcesByIds(ids: readonly string[]): Promise<Map<string, Source>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.#db.query<Row>(`SELECT * FROM sources WHERE id IN (${placeholders})`, [...ids]);
    return new Map(rows.map((row) => { const source = toSource(row); return [source.id, source] as const; }));
  }

  async updateSource(id: string, patch: Partial<Pick<Source, "status" | "title" | "quality" | "contentHash" | "storageKey" | "retrievedAt" | "failureReason" | "metadata" | "authors" | "publishedAt" | "sourceType" | "domain">>, updatedAt: string): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => { sets.push(`${column} = ?`); params.push(value); };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.quality !== undefined) { set("quality", toJson(patch.quality)); set("quality_score", patch.quality?.score ?? null); }
    if (patch.contentHash !== undefined) set("content_hash", patch.contentHash);
    if (patch.storageKey !== undefined) set("storage_key", patch.storageKey);
    if (patch.retrievedAt !== undefined) set("retrieved_at", patch.retrievedAt);
    if (patch.failureReason !== undefined) set("failure_reason", patch.failureReason);
    if (patch.metadata !== undefined) set("metadata", toJson(patch.metadata));
    if (patch.authors !== undefined) set("authors", toJson(patch.authors));
    if (patch.publishedAt !== undefined) set("published_at", patch.publishedAt);
    if (patch.sourceType !== undefined) set("source_type", patch.sourceType);
    if (patch.domain !== undefined) set("domain", patch.domain);
    if (sets.length === 0) return;
    set("updated_at", updatedAt);
    params.push(id);
    await this.#db.execute(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  /* ---------- Documents and chunks ---------- */

  async saveDocument(document: SourceDocument, chunks: readonly SourceChunk[]): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO source_documents (id, project_id, source_id, title, text, sections, language, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [document.id, document.projectId, document.sourceId, document.title, document.text,
         toJson(document.sections), document.language, document.tokenCount, document.createdAt],
      );
      for (const chunk of chunks) {
        await tx.execute(
          `INSERT INTO source_chunks (id, project_id, source_id, document_id, position, text, start_offset,
            end_offset, locator, token_count, embedding, embedding_model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [chunk.id, chunk.projectId, chunk.sourceId, chunk.documentId, chunk.position, chunk.text,
           chunk.startOffset, chunk.endOffset, chunk.locator, chunk.tokenCount,
           toJson(chunk.embedding), chunk.embeddingModel, chunk.createdAt],
        );
      }
    });
  }

  async listChunks(sourceId: string): Promise<SourceChunk[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM source_chunks WHERE source_id = ? ORDER BY position", [sourceId]);
    return rows.map(toChunk);
  }

  async findChunks(ids: readonly string[]): Promise<SourceChunk[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.#db.query<Row>(`SELECT * FROM source_chunks WHERE id IN (${placeholders})`, [...ids]);
    return rows.map(toChunk);
  }

  async listProjectChunks(projectId: string, limit = 5000): Promise<SourceChunk[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM source_chunks WHERE project_id = ? ORDER BY id LIMIT ?", [projectId, limit]);
    return rows.map(toChunk);
  }

  async setChunkEmbedding(chunkId: string, embedding: readonly number[], model: string): Promise<void> {
    await this.#db.execute("UPDATE source_chunks SET embedding = ?, embedding_model = ? WHERE id = ?", [toJson(embedding), model, chunkId]);
  }

  /* ---------- Evidence ---------- */

  async addEvidence(items: readonly Evidence[]): Promise<void> {
    for (const item of items) {
      await this.#db.execute(
        `INSERT INTO evidence (id, project_id, source_id, chunk_ids, quote, locator, interpretation, stance,
          strength, relevance, extracted_by_run_id, verified_at, verification_passed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.id, item.projectId, item.sourceId, toJson(item.chunkIds), item.quote, item.locator,
         item.interpretation, item.stance, toJson(item.strength), item.relevance,
         item.extractedByRunId, item.verifiedAt, item.verificationPassed, item.createdAt],
      );
    }
  }

  async listEvidence(projectId: string, options: { limit?: number; cursor?: string } = {}): Promise<Evidence[]> {
    const conditions = ["project_id = ?"];
    const params: (string | number)[] = [projectId];
    if (options.cursor) { conditions.push("id < ?"); params.push(options.cursor); }
    params.push(options.limit ?? 200);
    const rows = await this.#db.query<Row>(`SELECT * FROM evidence WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, params);
    return rows.map(toEvidence);
  }

  async findEvidence(ids: readonly string[]): Promise<Evidence[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.#db.query<Row>(`SELECT * FROM evidence WHERE id IN (${placeholders})`, [...ids]);
    return rows.map(toEvidence);
  }

  async markEvidenceVerified(id: string, passed: boolean, verifiedAt: string): Promise<void> {
    await this.#db.execute("UPDATE evidence SET verified_at = ?, verification_passed = ? WHERE id = ?", [verifiedAt, passed, id]);
  }

  /* ---------- Claims ---------- */

  async addClaim(claim: Claim): Promise<void> {
    await this.#db.execute(
      `INSERT INTO claims (id, project_id, question_id, hypothesis_id, statement, scope, claim_type, status,
        assumptions, confidence, confidence_score, proposed_by_run_id, superseded_by_claim_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [claim.id, claim.projectId, claim.questionId, claim.hypothesisId, claim.statement, claim.scope,
       claim.claimType, claim.status, toJson(claim.assumptions), toJson(claim.confidence),
       claim.confidence?.score ?? null, claim.proposedByRunId, claim.supersededByClaimId,
       claim.createdAt, claim.updatedAt],
    );
  }

  async findClaim(id: string): Promise<Claim | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM claims WHERE id = ?", [id]);
    return row ? toClaim(row) : undefined;
  }

  async listClaims(projectId: string, options: { status?: string; minConfidence?: number; questionId?: string; limit?: number; cursor?: string } = {}): Promise<Claim[]> {
    const conditions = ["project_id = ?"];
    const params: (string | number)[] = [projectId];
    if (options.status) { conditions.push("status = ?"); params.push(options.status); }
    if (options.questionId) { conditions.push("question_id = ?"); params.push(options.questionId); }
    if (options.minConfidence !== undefined) { conditions.push("confidence_score >= ?"); params.push(options.minConfidence); }
    if (options.cursor) { conditions.push("id < ?"); params.push(options.cursor); }
    params.push(options.limit ?? 200);
    const rows = await this.#db.query<Row>(`SELECT * FROM claims WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, params);
    return rows.map(toClaim);
  }

  async updateClaim(id: string, patch: Partial<Pick<Claim, "status" | "confidence" | "statement" | "scope" | "assumptions" | "supersededByClaimId">>, updatedAt: string): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => { sets.push(`${column} = ?`); params.push(value); };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.confidence !== undefined) { set("confidence", toJson(patch.confidence)); set("confidence_score", patch.confidence?.score ?? null); }
    if (patch.statement !== undefined) set("statement", patch.statement);
    if (patch.scope !== undefined) set("scope", patch.scope);
    if (patch.assumptions !== undefined) set("assumptions", toJson(patch.assumptions));
    if (patch.supersededByClaimId !== undefined) set("superseded_by_claim_id", patch.supersededByClaimId);
    if (sets.length === 0) return;
    set("updated_at", updatedAt);
    params.push(id);
    await this.#db.execute(`UPDATE claims SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  /* ---------- Claim links and relations ---------- */

  async linkEvidence(links: readonly ClaimEvidenceLink[]): Promise<void> {
    const conflict = this.#db.dialect.upsert(["claim_id", "evidence_id"], ["stance", "rationale"]);
    for (const link of links) {
      await this.#db.execute(
        `INSERT INTO claim_evidence (claim_id, evidence_id, stance, rationale, linked_by_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ${conflict}`,
        [link.claimId, link.evidenceId, link.stance, link.rationale ?? null, link.linkedByRunId, link.createdAt],
      );
    }
  }

  async evidenceForClaim(claimId: string): Promise<{ link: ClaimEvidenceLink; evidence: Evidence }[]> {
    const rows = await this.#db.query<Row>(
      `SELECT ce.stance AS link_stance, ce.rationale AS link_rationale, ce.linked_by_run_id, ce.created_at AS link_created_at, e.*
       FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id
       WHERE ce.claim_id = ? ORDER BY e.id`,
      [claimId],
    );
    return rows.map((row) => ({
      link: {
        claimId,
        evidenceId: str(row, "id"),
        stance: str(row, "link_stance"),
        rationale: strOrNull(row, "link_rationale") ?? undefined,
        linkedByRunId: strOrNull(row, "linked_by_run_id"),
        createdAt: str(row, "link_created_at"),
      } as ClaimEvidenceLink,
      evidence: toEvidence(row),
    }));
  }

  async listEvidenceLinks(projectId: string): Promise<ClaimEvidenceLink[]> {
    const rows = await this.#db.query<Row>(
      `SELECT ce.* FROM claim_evidence ce JOIN claims c ON c.id = ce.claim_id WHERE c.project_id = ?`,
      [projectId],
    );
    return rows.map((row) => ({
      claimId: str(row, "claim_id"),
      evidenceId: str(row, "evidence_id"),
      stance: str(row, "stance"),
      rationale: strOrNull(row, "rationale") ?? undefined,
      linkedByRunId: strOrNull(row, "linked_by_run_id"),
      createdAt: str(row, "created_at"),
    })).map((value) => asEntity<ClaimEvidenceLink>(value));
  }

  async addRelation(relation: ClaimRelation): Promise<void> {
    const conflict = this.#db.dialect.upsert(["from_claim_id", "to_claim_id", "relation"], ["rationale", "strength"]);
    await this.#db.execute(
      `INSERT INTO claim_relations (from_claim_id, to_claim_id, relation, rationale, strength, created_by_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ${conflict}`,
      [relation.fromClaimId, relation.toClaimId, relation.relation, relation.rationale ?? null,
       relation.strength, relation.createdByRunId, relation.createdAt],
    );
  }

  async listRelations(projectId: string): Promise<ClaimRelation[]> {
    const rows = await this.#db.query<Row>(
      `SELECT cr.* FROM claim_relations cr JOIN claims c ON c.id = cr.from_claim_id WHERE c.project_id = ?`,
      [projectId],
    );
    return rows.map((row) => ({
      fromClaimId: str(row, "from_claim_id"),
      toClaimId: str(row, "to_claim_id"),
      relation: str(row, "relation"),
      rationale: strOrNull(row, "rationale") ?? undefined,
      strength: num(row, "strength"),
      createdByRunId: strOrNull(row, "created_by_run_id"),
      createdAt: str(row, "created_at"),
    })).map((value) => asEntity<ClaimRelation>(value));
  }

  /* ---------- Contradictions ---------- */

  async addContradiction(contradiction: Contradiction): Promise<void> {
    const conflict = this.#db.dialect.upsert(["claim_id_a", "claim_id_b"], ["severity", "description", "status", "updated_at"]);
    await this.#db.execute(
      `INSERT INTO contradictions (id, project_id, claim_id_a, claim_id_b, kind, status, description, severity,
        candidate_explanations, resolution, resolved_by_run_id, detected_by_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
      [contradiction.id, contradiction.projectId, contradiction.claimIdA, contradiction.claimIdB, contradiction.kind,
       contradiction.status, contradiction.description, contradiction.severity,
       toJson(contradiction.candidateExplanations), contradiction.resolution, contradiction.resolvedByRunId,
       contradiction.detectedByRunId, contradiction.createdAt, contradiction.updatedAt],
    );
  }

  async listContradictions(projectId: string, status?: string): Promise<Contradiction[]> {
    const conditions = ["project_id = ?"];
    const params: string[] = [projectId];
    if (status) { conditions.push("status = ?"); params.push(status); }
    const rows = await this.#db.query<Row>(`SELECT * FROM contradictions WHERE ${conditions.join(" AND ")} ORDER BY severity DESC, id`, params);
    return rows.map(toContradiction);
  }

  async contradictionsForClaim(claimId: string): Promise<Contradiction[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM contradictions WHERE claim_id_a = ? OR claim_id_b = ?", [claimId, claimId]);
    return rows.map(toContradiction);
  }

  async resolveContradiction(id: string, patch: { status: string; resolution: string | null; resolvedByRunId: string | null; candidateExplanations?: readonly string[] }, updatedAt: string): Promise<void> {
    const sets = ["status = ?", "resolution = ?", "resolved_by_run_id = ?", "updated_at = ?"];
    const params: (string | number | null)[] = [patch.status, patch.resolution, patch.resolvedByRunId, updatedAt];
    if (patch.candidateExplanations) {
      sets.splice(3, 0, "candidate_explanations = ?");
      params.splice(3, 0, toJson(patch.candidateExplanations));
    }
    params.push(id);
    await this.#db.execute(`UPDATE contradictions SET ${sets.join(", ")} WHERE id = ?`, params);
  }
}

function toChunk(row: Row): SourceChunk {
  return asEntity<SourceChunk>({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    sourceId: str(row, "source_id"),
    documentId: str(row, "document_id"),
    position: num(row, "position"),
    text: str(row, "text"),
    startOffset: num(row, "start_offset"),
    endOffset: num(row, "end_offset"),
    locator: strOrNull(row, "locator"),
    tokenCount: num(row, "token_count"),
    embedding: jsonOrNull<number[]>(row, "embedding"),
    embeddingModel: strOrNull(row, "embedding_model"),
    createdAt: str(row, "created_at"),
  });
}

export { toSource, toEvidence, toClaim, toContradiction, toChunk, numOrNull };
