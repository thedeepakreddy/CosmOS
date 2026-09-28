# Future Integration Points

> **⚠️ NONE of these integrations are implemented in v0.1.**
>
> This document describes planned integration points for architectural planning purposes only.
> No code, adapters, or imports for these integrations exist in the codebase.
> EvalOS v0.1 is a fully independent project with zero runtime dependencies on any external OS.

---

## Integration Philosophy

EvalOS integrates with external systems through **contracts, not imports**.

- No shared code between EvalOS and other OS projects.
- Integration happens via HTTP APIs, adapters, and well-defined data contracts.
- Each integration is implemented as a `CandidateAdapter` and/or a set of `Evaluator` implementations.
- EvalOS never imports from AgentOS, ToolOS, ResearchOS, or MemoryOS at the TypeScript level.

---

## AgentOS

### Purpose
Evaluate AI agent performance on task completion, tool selection, reasoning quality, and multi-step execution.

### Integration Pattern
- **Adapter**: `AgentOSCandidateAdapter` wraps AgentOS HTTP API.
- **Input**: Task description, context, available tools.
- **Output**: Agent trace (steps taken, tools called, final answer).

### Evaluation Metrics

| Metric | Evaluator Type | Description |
|---|---|---|
| `task_completion` | DETERMINISTIC | Did the agent complete the assigned task? |
| `tool_selection_accuracy` | RULE_BASED | Did the agent select appropriate tools for each step? |
| `reasoning_quality` | MODEL_JUDGE | Quality of the agent's reasoning chain. |
| `step_efficiency` | RULE_BASED | Number of steps taken vs optimal path. |
| `error_recovery` | RULE_BASED | Did the agent recover from errors appropriately? |
| `hallucination_rate` | MODEL_JUDGE | Did the agent fabricate information? |

### Data Flow

```
AgentOS Task → AgentOS API → Agent Trace
                                ↓
EvalOS ← AgentOSCandidateAdapter.execute()
  ↓
Evaluators → Scores → Comparison → Regression Detection
```

### Prerequisites (NOT met in v0.1)
- AgentOS must expose a stable HTTP API for task execution.
- Agent trace format must be standardized and documented.
- MODEL_JUDGE evaluators require unblocked JudgeProvider.

---

## ToolOS

### Purpose
Evaluate tool reliability, performance, and output quality.

### Integration Pattern
- **Adapter**: `ToolOSCandidateAdapter` wraps ToolOS HTTP API for individual tool execution.
- **Input**: Tool name, tool input parameters.
- **Output**: Tool output, execution metadata (latency, status, retries).

### Evaluation Metrics

| Metric | Evaluator Type | Description |
|---|---|---|
| `tool_success_rate` | DETERMINISTIC | Percentage of successful tool executions. |
| `tool_latency` | RULE_BASED | Response time within acceptable thresholds. |
| `tool_timeout_rate` | DETERMINISTIC | Frequency of timeouts. |
| `output_correctness` | RULE_BASED / MODEL_JUDGE | Is the tool output correct for the given input? |
| `output_schema_valid` | RULE_BASED | Does the tool output match its declared schema? |
| `retry_rate` | DETERMINISTIC | How often does the tool require retries? |

### Data Flow

```
Tool Input → ToolOS API → Tool Output + Metadata
                              ↓
EvalOS ← ToolOSCandidateAdapter.execute()
  ↓
Evaluators → Scores → Comparison → Regression Detection
```

### Prerequisites (NOT met in v0.1)
- ToolOS must expose individual tool execution via HTTP API.
- Tool output schemas must be discoverable for schema validation.
- Latency and retry metadata must be included in tool responses.

---

## ResearchOS

### Purpose
Evaluate research output quality, citation correctness, and claim support.

### Integration Pattern
- **Adapter**: `ResearchOSCandidateAdapter` wraps ResearchOS HTTP API.
- **Input**: Research query, context, source constraints.
- **Output**: Research report with citations, claims, and sources.

### Evaluation Metrics

| Metric | Evaluator Type | Description |
|---|---|---|
| `citation_correctness` | RULE_BASED | Do citations point to real, accessible sources? |
| `claim_support` | MODEL_JUDGE | Are claims in the report supported by cited sources? |
| `unsupported_claims` | MODEL_JUDGE | Count of claims without adequate source support. |
| `source_diversity` | RULE_BASED | Variety of sources used (not over-reliance on one). |
| `coverage` | MODEL_JUDGE | Does the report cover the key aspects of the query? |
| `factual_accuracy` | MODEL_JUDGE | Are stated facts correct? |
| `recency` | RULE_BASED | Are sources sufficiently recent for the topic? |

### Data Flow

```
Research Query → ResearchOS API → Research Report
                                     ↓
EvalOS ← ResearchOSCandidateAdapter.execute()
  ↓
Evaluators → Scores → Comparison → Regression Detection
```

### Prerequisites (NOT met in v0.1)
- ResearchOS must expose research execution via HTTP API.
- Research output must include structured citations (not just inline text).
- MODEL_JUDGE evaluators require unblocked JudgeProvider.
- Ground truth datasets needed for factual accuracy evaluation.

---

## MemoryOS

### Purpose
Evaluate memory system recall accuracy, retrieval relevance, and latency.

### Integration Pattern
- **Adapter**: `MemoryOSCandidateAdapter` wraps MemoryOS HTTP API.
- **Input**: Memory query, context, filters.
- **Output**: Retrieved memories with relevance scores and metadata.

### Evaluation Metrics

| Metric | Evaluator Type | Description |
|---|---|---|
| `recall_accuracy` | DETERMINISTIC | Percentage of relevant memories successfully retrieved. |
| `precision` | DETERMINISTIC | Percentage of retrieved memories that are relevant. |
| `retrieval_latency` | RULE_BASED | Time to retrieve memories within threshold. |
| `relevance_ordering` | RULE_BASED | Are results ordered by relevance correctly? |
| `f1_score` | DETERMINISTIC | Harmonic mean of precision and recall. |
| `context_relevance` | MODEL_JUDGE | Is the retrieved context relevant to the query? |

### Data Flow

```
Memory Query → MemoryOS API → Retrieved Memories
                                  ↓
EvalOS ← MemoryOSCandidateAdapter.execute()
  ↓
Evaluators → Scores → Comparison → Regression Detection
```

### Prerequisites (NOT met in v0.1)
- MemoryOS must expose retrieval via HTTP API.
- Ground truth datasets with known-relevant memories needed for recall/precision.
- Relevance scoring must be included in retrieval responses.

---

## Aira

### Purpose
Evaluate Aira's conversational quality, task routing, and end-to-end user experience.

### Integration Pattern
- **Adapter**: `AiraCandidateAdapter` wraps Aira's HTTP API.
- **Input**: User message, conversation history, context.
- **Output**: Aira response, routing decisions, tool calls.

### Evaluation Metrics

| Metric | Evaluator Type | Description |
|---|---|---|
| `response_quality` | MODEL_JUDGE | Quality and helpfulness of the response. |
| `routing_accuracy` | DETERMINISTIC | Did Aira route to the correct subsystem? |
| `response_latency` | RULE_BASED | End-to-end response time. |
| `conversation_coherence` | MODEL_JUDGE | Is the conversation coherent across turns? |
| `task_completion` | DETERMINISTIC / MODEL_JUDGE | Did Aira complete the user's request? |

### Prerequisites (NOT met in v0.1)
- Aira must expose a stable conversational HTTP API.
- Routing decisions must be included in response metadata.
- Multi-turn evaluation datasets needed.

---

## Echo

### Purpose
Evaluate Echo's synthesis and analysis capabilities.

### Integration Pattern
- **Adapter**: `EchoCandidateAdapter` wraps Echo's HTTP API.
- **Input**: Analysis request, source data.
- **Output**: Synthesized analysis, insights, recommendations.

### Evaluation Metrics

| Metric | Evaluator Type | Description |
|---|---|---|
| `synthesis_quality` | MODEL_JUDGE | Quality of the synthesized analysis. |
| `insight_relevance` | MODEL_JUDGE | Are insights relevant to the input data? |
| `completeness` | MODEL_JUDGE | Does the analysis cover key aspects? |
| `accuracy` | RULE_BASED / MODEL_JUDGE | Are claims in the analysis accurate? |
| `processing_latency` | RULE_BASED | Time to produce the analysis. |

### Prerequisites (NOT met in v0.1)
- Echo must expose analysis via HTTP API.
- Output format must be structured for automated evaluation.
- Ground truth datasets for accuracy evaluation.

---

## Integration Implementation Checklist

When implementing any integration (post-v0.1), follow this checklist:

- [ ] Define the `CandidateAdapter` implementation
- [ ] Document the expected input/output contract
- [ ] Create a dataset of evaluation cases with expected outputs
- [ ] Implement deterministic evaluators first (highest value, no external deps)
- [ ] Add rule-based evaluators for threshold-based metrics
- [ ] Defer model-judge evaluators until JudgeProvider is unblocked
- [ ] Write integration tests with mock HTTP responses
- [ ] Document the evaluation suite configuration
- [ ] Set up baseline runs for regression detection
- [ ] Configure quality gates for release gating

---

## What EvalOS Does NOT Do

Even with integrations:

- ❌ EvalOS does not call AgentOS/ToolOS/etc. to fix problems it detects.
- ❌ EvalOS does not deploy new versions of any system.
- ❌ EvalOS does not rewrite prompts or modify configurations.
- ❌ EvalOS does not make decisions — it provides evidence for humans or CI systems to make decisions.

**EvalOS MEASURES. The rest is someone else's job.**
