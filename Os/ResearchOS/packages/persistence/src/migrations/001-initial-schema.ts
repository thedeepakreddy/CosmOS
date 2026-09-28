/**
 * Initial schema.
 *
 * Written once against the dialect abstraction so PostgreSQL and SQLite cannot
 * drift apart. Conventions used throughout:
 *
 *   - IDs are prefixed ULIDs stored as TEXT. They sort by creation time, so
 *     `ORDER BY id` is a valid chronological order and cursor pagination needs
 *     no secondary key.
 *   - Timestamps are ISO-8601 UTC strings (see dialect.ts for why).
 *   - JSON columns hold structured values that are read as a unit and never
 *     filtered on in SQL. Anything queried gets its own column.
 *   - Every research artifact carries `project_id` and cascades from it, so
 *     deleting a project cannot leave orphans.
 */
import type { SqlDialect } from "../dialect.ts";

export const id = "001-initial-schema";

export function up(d: SqlDialect): string[] {
  const { text, json, timestamp, boolean: bool, integer, real } = d;
  const pk = `${d.id} PRIMARY KEY`;
  const fkProject = `${d.id} NOT NULL REFERENCES projects(id) ON DELETE CASCADE`;

  return [
    /* ---------- Projects and the research question tree ---------- */
    `CREATE TABLE IF NOT EXISTS projects (
      id ${pk},
      tenant_id ${text},
      created_by ${json},
      title ${text} NOT NULL,
      description ${text},
      original_question ${text} NOT NULL,
      status ${text} NOT NULL,
      preferences ${json} NOT NULL,
      budget ${json} NOT NULL,
      failure_reason ${text},
      metadata ${json} NOT NULL,
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL,
      completed_at ${timestamp}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`,
    `CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id)`,

    `CREATE TABLE IF NOT EXISTS objectives (
      id ${pk},
      project_id ${fkProject},
      statement ${text} NOT NULL,
      rationale ${text},
      position ${integer} NOT NULL,
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_objectives_project ON objectives(project_id, position)`,

    `CREATE TABLE IF NOT EXISTS research_questions (
      id ${pk},
      project_id ${fkProject},
      parent_question_id ${text} REFERENCES research_questions(id) ON DELETE SET NULL,
      text ${text} NOT NULL,
      kind ${text} NOT NULL,
      status ${text} NOT NULL,
      rationale ${text},
      priority ${integer} NOT NULL,
      answer_summary ${text},
      answer_claim_ids ${json} NOT NULL,
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_questions_project ON research_questions(project_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_questions_parent ON research_questions(parent_question_id)`,

    `CREATE TABLE IF NOT EXISTS hypotheses (
      id ${pk},
      project_id ${fkProject},
      question_id ${text} REFERENCES research_questions(id) ON DELETE SET NULL,
      statement ${text} NOT NULL,
      rationale ${text},
      status ${text} NOT NULL,
      falsification_criteria ${text},
      prior_confidence ${real},
      posterior_confidence ${real},
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_hypotheses_project ON hypotheses(project_id, status)`,

    `CREATE TABLE IF NOT EXISTS research_plans (
      project_id ${fkProject},
      version ${integer} NOT NULL,
      summary ${text} NOT NULL,
      strategy ${text} NOT NULL,
      steps ${json} NOT NULL,
      created_by_run_id ${text},
      created_at ${timestamp} NOT NULL,
      PRIMARY KEY (project_id, version)
    )`,

    /* ---------- Sources, documents, chunks ---------- */
    `CREATE TABLE IF NOT EXISTS sources (
      id ${pk},
      project_id ${fkProject},
      url ${text},
      doi ${text},
      title ${text} NOT NULL,
      authors ${json} NOT NULL,
      publisher ${text},
      published_at ${timestamp},
      source_type ${text} NOT NULL,
      status ${text} NOT NULL,
      domain ${text},
      content_hash ${text},
      storage_key ${text},
      retrieved_at ${timestamp},
      quality ${json},
      quality_score ${real},
      discovered_by ${text},
      failure_reason ${text},
      metadata ${json} NOT NULL,
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_sources_domain ON sources(project_id, domain)`,
    // Deduplication: the same content discovered twice in one project is one source.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_content ON sources(project_id, content_hash) WHERE content_hash IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS source_documents (
      id ${pk},
      project_id ${fkProject},
      source_id ${d.id} NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      title ${text} NOT NULL,
      text ${text} NOT NULL,
      sections ${json} NOT NULL,
      language ${text},
      token_count ${integer} NOT NULL,
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_documents_source ON source_documents(source_id)`,

    `CREATE TABLE IF NOT EXISTS source_chunks (
      id ${pk},
      project_id ${fkProject},
      source_id ${d.id} NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      document_id ${d.id} NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
      position ${integer} NOT NULL,
      text ${text} NOT NULL,
      start_offset ${integer} NOT NULL,
      end_offset ${integer} NOT NULL,
      locator ${text},
      token_count ${integer} NOT NULL,
      embedding ${json},
      embedding_model ${text},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_document ON source_chunks(document_id, position)`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_project ON source_chunks(project_id)`,

    /* ---------- Evidence and claims ---------- */
    `CREATE TABLE IF NOT EXISTS evidence (
      id ${pk},
      project_id ${fkProject},
      source_id ${d.id} NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chunk_ids ${json} NOT NULL,
      quote ${text} NOT NULL,
      locator ${text},
      interpretation ${text} NOT NULL,
      stance ${text} NOT NULL,
      strength ${json} NOT NULL,
      relevance ${real} NOT NULL,
      extracted_by_run_id ${text},
      verified_at ${timestamp},
      verification_passed ${bool},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source_id)`,

    `CREATE TABLE IF NOT EXISTS claims (
      id ${pk},
      project_id ${fkProject},
      question_id ${text} REFERENCES research_questions(id) ON DELETE SET NULL,
      hypothesis_id ${text} REFERENCES hypotheses(id) ON DELETE SET NULL,
      statement ${text} NOT NULL,
      scope ${text},
      claim_type ${text} NOT NULL,
      status ${text} NOT NULL,
      assumptions ${json} NOT NULL,
      confidence ${json},
      confidence_score ${real},
      proposed_by_run_id ${text},
      superseded_by_claim_id ${text},
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_claims_question ON claims(question_id)`,
    `CREATE INDEX IF NOT EXISTS idx_claims_confidence ON claims(project_id, confidence_score)`,

    `CREATE TABLE IF NOT EXISTS claim_evidence (
      claim_id ${d.id} NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      evidence_id ${d.id} NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      stance ${text} NOT NULL,
      rationale ${text},
      linked_by_run_id ${text},
      created_at ${timestamp} NOT NULL,
      PRIMARY KEY (claim_id, evidence_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_claim_evidence_evidence ON claim_evidence(evidence_id)`,

    `CREATE TABLE IF NOT EXISTS claim_relations (
      from_claim_id ${d.id} NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      to_claim_id ${d.id} NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      relation ${text} NOT NULL,
      rationale ${text},
      strength ${real} NOT NULL,
      created_by_run_id ${text},
      created_at ${timestamp} NOT NULL,
      PRIMARY KEY (from_claim_id, to_claim_id, relation)
    )`,

    `CREATE TABLE IF NOT EXISTS contradictions (
      id ${pk},
      project_id ${fkProject},
      claim_id_a ${d.id} NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      claim_id_b ${d.id} NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      kind ${text} NOT NULL,
      status ${text} NOT NULL,
      description ${text} NOT NULL,
      severity ${real} NOT NULL,
      candidate_explanations ${json} NOT NULL,
      resolution ${text},
      resolved_by_run_id ${text},
      detected_by_run_id ${text},
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_contradictions_project ON contradictions(project_id, status)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_contradiction_pair ON contradictions(claim_id_a, claim_id_b)`,

    /* ---------- Orchestration ---------- */
    `CREATE TABLE IF NOT EXISTS tasks (
      id ${pk},
      project_id ${fkProject},
      type ${text} NOT NULL,
      status ${text} NOT NULL,
      priority ${integer} NOT NULL,
      depends_on ${json} NOT NULL,
      input ${json},
      output ${json},
      attempts ${integer} NOT NULL,
      max_attempts ${integer} NOT NULL,
      leased_by ${text},
      lease_expires_at ${timestamp},
      run_after ${timestamp} NOT NULL,
      awaiting_request_id ${text},
      error_code ${text},
      error_message ${text},
      trace_id ${text},
      metadata ${json} NOT NULL,
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL,
      started_at ${timestamp},
      finished_at ${timestamp}
    )`,
    // The queue's hot path: runnable tasks ordered by priority then age.
    `CREATE INDEX IF NOT EXISTS idx_tasks_claimable ON tasks(status, run_after, priority)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_awaiting ON tasks(awaiting_request_id)`,

    // Dependencies live in their own table rather than inside the tasks row.
    // The claim query has to ask "are all of this task's dependencies complete?"
    // on every poll, and a correlated NOT EXISTS over an indexed table is both
    // portable and fast — introspecting a JSON array in SQL is neither.
    `CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id ${d.id} NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id ${d.id} NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_task_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_task_id)`,

    `CREATE TABLE IF NOT EXISTS agent_runs (
      id ${pk},
      project_id ${fkProject},
      task_id ${text},
      role ${text} NOT NULL,
      status ${text} NOT NULL,
      model ${text},
      provider ${text},
      input ${json},
      output ${json},
      usage ${json} NOT NULL,
      trace_id ${text},
      error_code ${text},
      error_message ${text},
      started_at ${timestamp} NOT NULL,
      finished_at ${timestamp},
      duration_ms ${integer}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)`,

    /* ---------- Critique, failure memory, verification, debate ---------- */
    `CREATE TABLE IF NOT EXISTS critique_findings (
      id ${pk},
      project_id ${fkProject},
      kind ${text} NOT NULL,
      status ${text} NOT NULL,
      target_type ${text} NOT NULL,
      target_id ${text} NOT NULL,
      description ${text} NOT NULL,
      resolution_criteria ${text},
      severity ${real} NOT NULL,
      raised_by_run_id ${text},
      resolved_by_run_id ${text},
      resolution ${text},
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_findings_target ON critique_findings(target_type, target_id)`,
    `CREATE INDEX IF NOT EXISTS idx_findings_project ON critique_findings(project_id, status)`,

    `CREATE TABLE IF NOT EXISTS failure_records (
      id ${pk},
      project_id ${fkProject},
      kind ${text} NOT NULL,
      approach ${text} NOT NULL,
      reason ${text} NOT NULL,
      lesson ${text},
      context ${json} NOT NULL,
      transferable ${bool} NOT NULL,
      recorded_by_run_id ${text},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_failures_project ON failure_records(project_id, kind)`,
    // Transferable failures are read across projects — that is the point of them.
    `CREATE INDEX IF NOT EXISTS idx_failures_transferable ON failure_records(transferable, kind)`,

    `CREATE TABLE IF NOT EXISTS verification_checks (
      id ${pk},
      project_id ${fkProject},
      check_type ${text} NOT NULL,
      target_type ${text} NOT NULL,
      target_id ${text} NOT NULL,
      outcome ${text} NOT NULL,
      detail ${text} NOT NULL,
      weight ${real} NOT NULL,
      verifier_provider ${text},
      verified_by_run_id ${text},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_verification_target ON verification_checks(target_type, target_id)`,

    `CREATE TABLE IF NOT EXISTS debates (
      id ${pk},
      project_id ${fkProject},
      subject_type ${text} NOT NULL,
      subject_id ${text} NOT NULL,
      topic ${text} NOT NULL,
      status ${text} NOT NULL,
      rounds ${integer} NOT NULL,
      max_rounds ${integer} NOT NULL,
      turns ${json} NOT NULL,
      verdict ${json},
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_debates_subject ON debates(subject_type, subject_id)`,
    `CREATE INDEX IF NOT EXISTS idx_debates_project ON debates(project_id, status)`,

    /* ---------- Experiments ---------- */
    `CREATE TABLE IF NOT EXISTS datasets (
      id ${pk},
      project_id ${fkProject},
      name ${text} NOT NULL,
      description ${text},
      version ${text} NOT NULL,
      uri ${text},
      storage_key ${text},
      row_count ${integer},
      schema ${json},
      content_hash ${text},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_datasets_project ON datasets(project_id)`,

    `CREATE TABLE IF NOT EXISTS experiments (
      id ${pk},
      project_id ${fkProject},
      hypothesis_id ${text} REFERENCES hypotheses(id) ON DELETE SET NULL,
      title ${text} NOT NULL,
      design ${text} NOT NULL,
      expected_outcome ${text},
      falsification_criteria ${text},
      status ${text} NOT NULL,
      code ${text} NOT NULL,
      environment ${json} NOT NULL,
      parameters ${json} NOT NULL,
      dataset_ids ${json} NOT NULL,
      designed_by_run_id ${text},
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_experiments_project ON experiments(project_id, status)`,

    `CREATE TABLE IF NOT EXISTS experiment_runs (
      id ${pk},
      project_id ${fkProject},
      experiment_id ${d.id} NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      attempt ${integer} NOT NULL,
      status ${text} NOT NULL,
      parameters ${json} NOT NULL,
      stdout ${text} NOT NULL,
      stderr ${text} NOT NULL,
      exit_code ${integer},
      metrics ${json} NOT NULL,
      artifacts ${json} NOT NULL,
      duration_ms ${integer},
      interpretation ${text},
      reproduced_run_id ${text},
      reproduction_matched ${bool},
      error_message ${text},
      started_at ${timestamp},
      finished_at ${timestamp},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_experiment_runs_experiment ON experiment_runs(experiment_id, attempt)`,

    /* ---------- Reports ---------- */
    `CREATE TABLE IF NOT EXISTS reports (
      id ${pk},
      project_id ${fkProject},
      version ${integer} NOT NULL,
      title ${text} NOT NULL,
      body ${json} NOT NULL,
      overall_confidence ${real} NOT NULL,
      generated_by_run_id ${text},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_reports_version ON reports(project_id, version)`,

    /* ---------- Event log ---------- */
    `CREATE TABLE IF NOT EXISTS research_events (
      id ${pk},
      project_id ${fkProject},
      sequence ${integer} NOT NULL,
      type ${text} NOT NULL,
      payload ${json} NOT NULL,
      trace_id ${text},
      metadata ${json} NOT NULL,
      occurred_at ${timestamp} NOT NULL
    )`,
    // Gapless per-project sequence: the resume contract for SSE clients.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_events_sequence ON research_events(project_id, sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_events_type ON research_events(project_id, type)`,

    /* ---------- Memory ---------- */
    `CREATE TABLE IF NOT EXISTS memory_records (
      id ${pk},
      layer ${text} NOT NULL,
      tenant_id ${text},
      project_id ${text},
      application ${text},
      visibility ${text} NOT NULL,
      memory_key ${text} NOT NULL,
      content ${json} NOT NULL,
      search_text ${text} NOT NULL,
      embedding ${json},
      embedding_model ${text},
      salience ${real} NOT NULL,
      reference_ids ${json} NOT NULL,
      tags ${json} NOT NULL,
      metadata ${json} NOT NULL,
      expires_at ${timestamp},
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL,
      last_accessed_at ${timestamp},
      access_count ${integer} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(layer, project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_tenant ON memory_records(tenant_id, layer)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_records(memory_key)`,

    `CREATE TABLE IF NOT EXISTS memory_links (
      from_memory_id ${d.id} NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      to_memory_id ${d.id} NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      type ${text} NOT NULL,
      weight ${real} NOT NULL,
      created_at ${timestamp} NOT NULL,
      PRIMARY KEY (from_memory_id, to_memory_id, type)
    )`,

    /* ---------- Research graph projection ---------- */
    `CREATE TABLE IF NOT EXISTS graph_nodes (
      id ${pk},
      project_id ${fkProject},
      type ${text} NOT NULL,
      entity_id ${text} NOT NULL,
      label ${text} NOT NULL,
      properties ${json} NOT NULL,
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_graph_node_entity ON graph_nodes(project_id, type, entity_id)`,

    `CREATE TABLE IF NOT EXISTS graph_edges (
      id ${pk},
      project_id ${fkProject},
      type ${text} NOT NULL,
      from_node_id ${d.id} NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      to_node_id ${d.id} NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      weight ${real} NOT NULL,
      properties ${json} NOT NULL,
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_graph_edge ON graph_edges(from_node_id, to_node_id, type)`,
    `CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(project_id, type)`,

    /* ---------- External executors ---------- */
    `CREATE TABLE IF NOT EXISTS executors (
      id ${pk},
      name ${text} NOT NULL,
      display_name ${text},
      capabilities ${json} NOT NULL,
      callback_url ${text},
      mode ${text} NOT NULL,
      status ${text} NOT NULL,
      max_concurrent_requests ${integer} NOT NULL,
      version ${text},
      token_hash ${text} NOT NULL,
      tenant_id ${text},
      last_heartbeat_at ${timestamp},
      metadata ${json} NOT NULL,
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_executors_name ON executors(name)`,
    `CREATE INDEX IF NOT EXISTS idx_executors_status ON executors(status)`,

    `CREATE TABLE IF NOT EXISTS executor_requests (
      id ${pk},
      project_id ${fkProject},
      task_id ${text},
      capability ${text} NOT NULL,
      tool_id ${text} NOT NULL,
      input ${json},
      status ${text} NOT NULL,
      executor_id ${text},
      output ${json},
      error_message ${text},
      timeout_ms ${integer} NOT NULL,
      expires_at ${timestamp} NOT NULL,
      created_at ${timestamp} NOT NULL,
      claimed_at ${timestamp},
      completed_at ${timestamp}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_executor_requests_claimable ON executor_requests(status, capability, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_executor_requests_task ON executor_requests(task_id)`,

    /* ---------- Observability ---------- */
    `CREATE TABLE IF NOT EXISTS model_calls (
      id ${pk},
      project_id ${text},
      agent_run_id ${text},
      provider ${text} NOT NULL,
      model ${text} NOT NULL,
      task_kind ${text},
      input_tokens ${integer} NOT NULL,
      output_tokens ${integer} NOT NULL,
      cached_input_tokens ${integer} NOT NULL,
      cost_usd ${real} NOT NULL,
      latency_ms ${integer} NOT NULL,
      stop_reason ${text},
      succeeded ${bool} NOT NULL,
      error_message ${text},
      trace_id ${text},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_model_calls_project ON model_calls(project_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS tool_calls (
      id ${pk},
      project_id ${text},
      agent_run_id ${text},
      tool_id ${text} NOT NULL,
      capability ${text} NOT NULL,
      input ${json},
      output ${json},
      status ${text} NOT NULL,
      error_message ${text},
      duration_ms ${integer} NOT NULL,
      executor_id ${text},
      trace_id ${text},
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tool_calls_project ON tool_calls(project_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS audit_log (
      id ${pk},
      tenant_id ${text},
      application ${text},
      actor ${text} NOT NULL,
      action ${text} NOT NULL,
      resource_type ${text} NOT NULL,
      resource_id ${text},
      allowed ${bool} NOT NULL,
      reason ${text},
      details ${json} NOT NULL,
      created_at ${timestamp} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`,
  ];
}
