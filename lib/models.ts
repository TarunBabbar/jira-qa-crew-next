// Data contracts — the faithful TS port of src/jira_qa_crew/models.py

export type Provenance =
  | "EXPLICIT"
  | "INFERRED"
  | "MISSING"
  | "ASSUMPTION_REQUIRING_CONFIRMATION";

export type Priority = "P0" | "P1" | "P2" | "P3";

export type TestType =
  | "happy_path" | "negative" | "boundary" | "validation"
  | "error_handling" | "state_transition" | "permissions"
  | "data_integrity" | "api_contract" | "accessibility"
  | "cross_browser" | "regression" | "recovery";

export type AutomationCandidate = "Yes" | "No" | "Partial";
export type AutomationReadiness = "READY" | "NEEDS_CONFIGURATION" | "NOT_APPLICABLE";
export type JiraSource = "MCP" | "REST" | "DEMO_FIXTURE";
export type TicketStatus =
  | "PENDING" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_WARNINGS" | "FAILED";
export type StageStatus = "PENDING" | "RUNNING" | "COMPLETED" | "WARNING" | "FAILED";
export type CoverageStatus = "COVERED" | "PARTIAL" | "UNCOVERED";

export const STAGE_NAMES = [
  "Jira Fetch",
  "Jira Analyst",
  "Test Plan Writer",
  "Test Case Writer",
  "Playwright Coder",
  "Artifacts",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const TEST_PLAN_SECTIONS = [
  "Executive Summary",
  "Test Objectives",
  "In Scope",
  "Out of Scope",
  "Requirements and Acceptance-Criteria Coverage",
  "Test Strategy, Levels, and Test Types",
  "Test Environment, Tools, and Browser Coverage",
  "Test Data Requirements",
  "High-Level Test Scenarios",
  "Entry and Exit Criteria",
  "Risks, Dependencies, Assumptions, and Mitigations",
  "Execution, Defect Management, Reporting, and Deliverables",
] as const;

// ---------------------------------------------------------------------------
// Jira issue (deterministic, never LLM-populated)
// ---------------------------------------------------------------------------
export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  issue_type: string;
  status: string;
  priority: string;
  labels: string[];
  components: string[];
  parent: string | null;
  subtasks: string[];
  linked_issues: string[];
  acceptance_criteria_raw: string;
  comments: string[];
  url: string;
  source: JiraSource;
  raw_fields: Record<string, unknown>;
}

export function issueToPromptText(issue: JiraIssue): string {
  const lines = [
    `Ticket Key: ${issue.key}`,
    `Summary: ${issue.summary}`,
    `Issue Type: ${issue.issue_type || "not set"}`,
    `Status: ${issue.status || "not set"}`,
    `Priority: ${issue.priority || "not set"}`,
    `Labels: ${issue.labels.join(", ") || "none"}`,
    `Components: ${issue.components.join(", ") || "none"}`,
    `Parent: ${issue.parent || "none"}`,
    `Subtasks: ${issue.subtasks.join(", ") || "none"}`,
    `Linked Issues: ${issue.linked_issues.join(", ") || "none"}`,
    `URL: ${issue.url || "not available"}`,
    "",
    "Description:",
    issue.description || "(empty)",
  ];
  if (issue.acceptance_criteria_raw) {
    lines.push("", "Acceptance Criteria field:", issue.acceptance_criteria_raw);
  }
  if (issue.comments.length) {
    lines.push("", "Comments:");
    lines.push(...issue.comments.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stage 1 — Requirement analysis
// ---------------------------------------------------------------------------
export interface Requirement {
  id: string;
  text: string;
  provenance: Provenance;
  source_quote: string;
  category: string;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  provenance: Provenance;
  source_quote: string;
  requirement_ids: string[];
}

export interface RequirementAnalysis {
  ticket_key: string;
  summary: string;
  issue_type: string;
  status: string;
  priority: string;
  labels: string[];
  components: string[];
  parent: string | null;
  subtasks: string[];
  linked_issues: string[];
  description_summary: string;
  requirements: Requirement[];
  acceptance_criteria: AcceptanceCriterion[];
  business_rules: string[];
  non_functional_requirements: string[];
  dependencies: string[];
  constraints: string[];
  risks: string[];
  assumptions: string[];
  missing_information: string[];
  open_questions: string[];
  source: JiraSource;
}

export function requirementIds(a: RequirementAnalysis): string[] {
  return a.requirements.map((r) => r.id);
}
export function acceptanceCriterionIds(a: RequirementAnalysis): string[] {
  return a.acceptance_criteria.map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Stage 2 — Test plan
// ---------------------------------------------------------------------------
export interface TestPlanSection {
  number: number;
  title: string;
  content: string;
}

export interface TestScenario {
  id: string;
  title: string;
  description: string;
  requirement_ids: string[];
  acceptance_criteria_ids: string[];
  priority: Priority;
}

export interface TestPlan {
  ticket_key: string;
  title: string;
  sections: TestPlanSection[];
  scenarios: TestScenario[];
}

// ---------------------------------------------------------------------------
// Stage 3 — Test cases
// ---------------------------------------------------------------------------
export interface TestStep {
  number: number;
  action: string;
  expected: string;
}

export interface TestCase {
  id: string;
  ticket_key: string;
  title: string;
  objective: string;
  priority: Priority;
  test_type: TestType;
  requirement_ids: string[];
  acceptance_criteria_ids: string[];
  preconditions: string[];
  test_data: string[];
  steps: TestStep[];
  expected_result: string;
  automation_candidate: AutomationCandidate;
  automation_rationale: string;
  tags: string[];
  assumptions_or_blockers: string[];
}

export interface TestCaseSuite {
  ticket_key: string;
  test_cases: TestCase[];
  coverage_notes: string;
}

// ---------------------------------------------------------------------------
// Stage 4 — Playwright bundle
// ---------------------------------------------------------------------------
export interface PlaywrightFile {
  path: string;
  content: string;
  kind: string;
}

export interface AutomatedTestTrace {
  test_name: string;
  test_case_id: string;
  ticket_key: string;
  requirement_ids: string[];
  acceptance_criteria_ids: string[];
  spec_path: string;
}

export interface PlaywrightBundle {
  ticket_key: string;
  files: PlaywrightFile[];
  traces: AutomatedTestTrace[];
  readiness: AutomationReadiness;
  setup_notes: string;
  missing_information: string[];
  assumptions: string[];
}

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------
export interface TraceabilityRow {
  requirement_id: string;
  requirement_text: string;
  acceptance_criterion_id: string;
  acceptance_criterion_text: string;
  test_case_ids: string[];
  automated_test_case_ids: string[];
  coverage_status: CoverageStatus;
  reason: string;
}

export interface CoverageReport {
  ticket_key: string;
  rows: TraceabilityRow[];
  total_requirements: number;
  covered_requirements: number;
  partially_covered_requirements: number;
  uncovered_requirements: number;
  total_acceptance_criteria: number;
  covered_acceptance_criteria: number;
  total_test_cases: number;
  automated_test_cases: number;
  orphan_requirement_ids: string[];
  orphan_acceptance_criteria_ids: string[];
  orphan_test_case_ids: string[];
  unknown_reference_ids: string[];
}

export function requirementCoveragePct(c: CoverageReport): number {
  if (!c.total_requirements) return 0;
  return Math.round((100 * c.covered_requirements) / c.total_requirements * 10) / 10;
}
export function automationPct(c: CoverageReport): number {
  if (!c.total_test_cases) return 0;
  return Math.round((100 * c.automated_test_cases) / c.total_test_cases * 10) / 10;
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------
export interface StageEvent {
  stage: StageName;
  status: StageStatus;
  message: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TicketResult {
  ticket_key: string;
  status: TicketStatus;
  source: JiraSource | null;
  issue: JiraIssue | null;
  analysis: RequirementAnalysis | null;
  test_plan: TestPlan | null;
  test_cases: TestCaseSuite | null;
  playwright: PlaywrightBundle | null;
  coverage: CoverageReport | null;
  stages: StageEvent[];
  warnings: string[];
  error: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunSummary {
  run_id: string;
  requested_keys: string[];
  invalid_inputs: string[];
  duplicates_removed: string[];
  results: TicketResult[];
  started_at: string | null;
  finished_at: string | null;
}

export function newStageSet(): StageEvent[] {
  return STAGE_NAMES.map((stage) => ({
    stage,
    status: "PENDING" as StageStatus,
    message: "",
    started_at: null,
    finished_at: null,
  }));
}
