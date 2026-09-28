/**
 * Research evolution, as a tree.
 *
 * Research produces questions as well as answers, and the questions are often
 * the more valuable output. This projection records what each finding opened
 * up — a contradiction nobody expected, a hypothesis the evidence now favours,
 * an experiment worth running — so the next run starts from the frontier rather
 * than from the original question.
 *
 * `priority` is the ranking of what to pursue next, and it is computed rather
 * than asserted by a model. Three things raise it: an unresolved contradiction
 * (severity), a question still open (its declared priority), and a claim whose
 * confidence sits near the middle. That last one is deliberate — a claim at 0.5
 * is the one more evidence would actually move, while a claim at 0.05 or 0.95
 * is mostly settled and more evidence buys little.
 */
import type {
  Claim, Contradiction, Experiment, Hypothesis, ResearchQuestion, ResearchTree, ResearchTreeNode,
} from "@research-os/contracts";
import { clamp01, round } from "@research-os/shared";

export interface TreeInput {
  readonly projectId: string;
  readonly originalQuestion: string;
  readonly questions?: readonly ResearchQuestion[];
  readonly hypotheses?: readonly Hypothesis[];
  readonly claims?: readonly Claim[];
  readonly contradictions?: readonly Contradiction[];
  readonly experiments?: readonly Experiment[];
  readonly now: string;
}

/**
 * How much a further round of evidence would change a claim.
 *
 * Peaks at 0.5 and falls to zero at either extreme. A claim we are unsure about
 * is where effort pays; a claim that is nearly settled is not.
 */
export function informationValue(confidence: number | null): number {
  if (confidence === null) return 0.8; // unmeasured is worth measuring
  return round(clamp01(1 - Math.abs(confidence - 0.5) * 2), 4);
}

function claimNode(claim: Claim): ResearchTreeNode {
  const confidence = claim.confidence?.score ?? null;
  const settled = claim.status === "supported" || claim.status === "refuted";
  return {
    id: claim.id,
    kind: "finding",
    label: claim.statement,
    entityId: claim.id,
    confidence,
    // A settled claim is still listed, but it is not what to work on next.
    priority: settled ? round(informationValue(confidence) * 0.25, 4) : informationValue(confidence),
    rationale: settled
      ? `Status ${claim.status}; further evidence would move this little.`
      : `Status ${claim.status}; confidence ${confidence === null ? "not yet computed" : confidence.toFixed(2)}.`,
    children: [],
  };
}

function contradictionNode(contradiction: Contradiction): ResearchTreeNode {
  const open = contradiction.status === "open" || contradiction.status === "investigating";
  return {
    id: contradiction.id,
    kind: "contradiction",
    label: contradiction.description,
    entityId: contradiction.id,
    confidence: null,
    // An unresolved contradiction is the highest-value thing in a research
    // project: it means two things currently believed cannot both be true.
    priority: open ? clamp01(contradiction.severity) : round(clamp01(contradiction.severity) * 0.1, 4),
    rationale: open
      ? `Unresolved ${contradiction.kind}. Two claims cannot both hold.`
      : `Resolved: ${contradiction.resolution ?? contradiction.status}`,
    children: contradiction.candidateExplanations.map((explanation, index) => ({
      id: `${contradiction.id}:explanation:${index}`,
      kind: "explanation" as const,
      label: explanation,
      entityId: null,
      confidence: null,
      priority: open ? 0.5 : 0.05,
      rationale: null,
      children: [],
    })),
  };
}

function hypothesisNode(hypothesis: Hypothesis): ResearchTreeNode {
  const untested = hypothesis.status === "proposed" || hypothesis.status === "testing";
  return {
    id: hypothesis.id,
    kind: "alternative_hypothesis",
    label: hypothesis.statement,
    entityId: hypothesis.id,
    confidence: hypothesis.posteriorConfidence ?? hypothesis.priorConfidence,
    priority: untested ? informationValue(hypothesis.posteriorConfidence ?? hypothesis.priorConfidence) : 0.1,
    rationale: hypothesis.falsificationCriteria
      ? `Falsified by: ${hypothesis.falsificationCriteria}`
      : "No falsification criteria recorded — this hypothesis is not yet testable.",
    children: [],
  };
}

function experimentNode(experiment: Experiment): ResearchTreeNode {
  const pending = experiment.status === "designed" || experiment.status === "ready";
  return {
    id: experiment.id,
    kind: "proposed_experiment",
    label: experiment.title,
    entityId: experiment.id,
    confidence: null,
    priority: pending ? 0.7 : 0.1,
    rationale: experiment.expectedOutcome,
    children: [],
  };
}

/**
 * Builds the tree.
 *
 * Sub-questions nest under their parent; everything attributable to a question
 * hangs beneath it, and anything unattributed hangs from the root — visible
 * rather than dropped. A node's priority is the greater of its own and its
 * best child's, so a settled question containing an open contradiction does not
 * sink out of sight.
 */
export function projectResearchTree(input: TreeInput): ResearchTree {
  const questions = input.questions ?? [];
  const byId = new Map(questions.map((question) => [question.id as string, question]));

  const nodesByQuestion = new Map<string, ResearchTreeNode>();
  for (const question of questions) {
    nodesByQuestion.set(question.id, {
      id: question.id,
      kind: question.status === "answered" ? "finding" : "open_question",
      label: question.text,
      entityId: question.id,
      confidence: null,
      priority: question.status === "answered" ? 0.1 : clamp01(question.priority / 100),
      rationale: question.answerSummary ?? null,
      children: [],
    });
  }

  const attach = (questionId: string | null | undefined, node: ResearchTreeNode, orphans: ResearchTreeNode[]): void => {
    const parent = questionId ? nodesByQuestion.get(questionId) : undefined;
    (parent?.children ?? orphans).push(node);
  };

  const orphans: ResearchTreeNode[] = [];
  for (const claim of input.claims ?? []) attach(claim.questionId, claimNode(claim), orphans);
  for (const hypothesis of input.hypotheses ?? []) attach(hypothesis.questionId, hypothesisNode(hypothesis), orphans);
  for (const experiment of input.experiments ?? []) orphans.push(experimentNode(experiment));
  for (const contradiction of input.contradictions ?? []) orphans.push(contradictionNode(contradiction));

  // Nest sub-questions under their parents; whatever has no parent in this set
  // becomes a direct child of the root.
  const topLevel: ResearchTreeNode[] = [];
  for (const question of questions) {
    const node = nodesByQuestion.get(question.id);
    if (!node) continue;
    const parent = question.parentQuestionId ? nodesByQuestion.get(question.parentQuestionId) : undefined;
    if (parent && byId.has(question.parentQuestionId as string)) parent.children.push(node);
    else topLevel.push(node);
  }

  const root: ResearchTreeNode = {
    id: input.projectId,
    kind: "original_question",
    label: input.originalQuestion,
    entityId: input.projectId,
    confidence: null,
    priority: 1,
    rationale: null,
    children: [...topLevel, ...orphans],
  };

  liftPriority(root);
  sortByPriority(root);
  return { projectId: input.projectId as ResearchTree["projectId"], root, generatedAt: input.now };
}

/** A parent is at least as urgent as its most urgent child. */
function liftPriority(node: ResearchTreeNode): number {
  let best = node.priority;
  for (const child of node.children) best = Math.max(best, liftPriority(child));
  node.priority = round(clamp01(best), 4);
  return node.priority;
}

function sortByPriority(node: ResearchTreeNode): void {
  node.children.sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label));
  for (const child of node.children) sortByPriority(child);
}

/** The highest-value places to continue, flattened and ranked. */
export function researchFrontier(tree: ResearchTree, limit = 10): ResearchTreeNode[] {
  const pursuable = new Set(["open_question", "contradiction", "proposed_experiment", "alternative_hypothesis"]);
  const collected: ResearchTreeNode[] = [];
  const walk = (node: ResearchTreeNode): void => {
    if (pursuable.has(node.kind)) collected.push(node);
    for (const child of node.children) walk(child);
  };
  walk(tree.root);
  return collected.sort((a, b) => b.priority - a.priority).slice(0, limit);
}
