// Deterministic post-stage validation — faithful TS port of services/validation.py

import type {
  PlaywrightBundle,
  RequirementAnalysis,
  TestCaseSuite,
  TestPlan,
} from "./models";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function ok(): ValidationResult {
  return { ok: true, errors: [], warnings: [] };
}

const REQ_RE = /^REQ-\d{3,}$/;
const AC_RE = /^AC-\d{3,}$/;
const TC_RE = /^[A-Z][A-Z0-9_]+-\d+-TC-\d{3,}$/;

export function validateAnalysis(obj: RequirementAnalysis, ticketKey: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!obj.ticket_key) errors.push("ticket_key is required");
  if (obj.ticket_key && obj.ticket_key !== ticketKey) {
    errors.push(`ticket_key must be ${ticketKey}, got ${obj.ticket_key}`);
  }

  const seen = new Set<string>();
  for (const req of obj.requirements ?? []) {
    const id = (req.id ?? "").trim().toUpperCase();
    if (!REQ_RE.test(id)) errors.push(`requirement id must look like REQ-001, got ${req.id}`);
    if (seen.has(id)) errors.push(`duplicate requirement id ${id}`);
    seen.add(id);
    if (req.provenance === "EXPLICIT" && !req.source_quote) {
      warnings.push(`${id} is marked EXPLICIT but has no source_quote`);
    }
  }
  const seenAc = new Set<string>();
  for (const ac of obj.acceptance_criteria ?? []) {
    const id = (ac.id ?? "").trim().toUpperCase();
    if (!AC_RE.test(id)) errors.push(`acceptance criterion id must look like AC-001, got ${ac.id}`);
    if (seenAc.has(id)) errors.push(`duplicate acceptance criterion id ${id}`);
    seenAc.add(id);
    for (const rid of ac.requirement_ids ?? []) {
      if (!seen.has(rid)) errors.push(`${id} references unknown requirement ${rid}`);
    }
  }
  for (const req of obj.requirements ?? []) {
    if (req.provenance === "EXPLICIT" && !req.source_quote.trim()) {
      warnings.push(`${req.id} is EXPLICIT but has no verbatim source quote`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validateTestPlan(
  plan: TestPlan,
  analysis: RequirementAnalysis,
  ticketKey: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (plan.ticket_key !== ticketKey) errors.push(`ticket_key must be ${ticketKey}`);
  const sections = plan.sections ?? [];
  if (sections.length !== 12) {
    errors.push(`a test plan must have exactly 12 sections, got ${sections.length}`);
  } else {
    const numbers = sections.map((s) => s.number).sort((a, b) => a - b);
    if (numbers.join(",") !== "1,2,3,4,5,6,7,8,9,10,11,12") {
      errors.push(`section numbers must be 1..12 exactly once, got ${numbers.join(",")}`);
    }
  }
  const knownIds = new Set([
    ...(analysis.requirements ?? []).map((r) => r.id),
    ...(analysis.acceptance_criteria ?? []).map((c) => c.id),
  ]);
  for (const scenario of plan.scenarios ?? []) {
    const refs = [...(scenario.requirement_ids ?? []), ...(scenario.acceptance_criteria_ids ?? [])];
    if (!refs.length) errors.push(`scenario ${scenario.id} must reference at least one REQ-* or AC-* id`);
    for (const ref of refs) {
      if (!knownIds.has(ref)) errors.push(`scenario ${scenario.id} references unknown id ${ref}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validateTestCases(
  suite: TestCaseSuite,
  analysis: RequirementAnalysis,
  ticketKey: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (suite.ticket_key !== ticketKey) errors.push(`ticket_key must be ${ticketKey}`);
  const cases = suite.test_cases ?? [];
  if (!cases.length) errors.push("a test case suite must contain at least one test case");

  const knownReq = new Set((analysis.requirements ?? []).map((r) => r.id));
  const knownAc = new Set((analysis.acceptance_criteria ?? []).map((c) => c.id));

  const seen = new Set<string>();
  for (const tc of cases) {
    const id = (tc.id ?? "").trim().toUpperCase();
    if (!TC_RE.test(id)) errors.push(`test case id must look like ${ticketKey}-TC-001, got ${tc.id}`);
    if (seen.has(id)) errors.push(`duplicate test case id ${id}`);
    seen.add(id);
    if (!(tc.steps ?? []).length) errors.push(`test case ${id} has no steps`);
    const refs = [...(tc.requirement_ids ?? []), ...(tc.acceptance_criteria_ids ?? [])];
    if (!refs.length) errors.push(`test case ${id} must trace to at least one REQ-* or AC-* id`);
    for (const ref of tc.requirement_ids ?? []) {
      if (!knownReq.has(ref)) errors.push(`${id} references unknown requirement ${ref}`);
    }
    for (const ref of tc.acceptance_criteria_ids ?? []) {
      if (!knownAc.has(ref)) errors.push(`${id} references unknown acceptance criterion ${ref}`);
    }
  }

  // Every AC needs a positive test.
  for (const ac of analysis.acceptance_criteria ?? []) {
    const covered = cases.some((tc) => (tc.acceptance_criteria_ids ?? []).includes(ac.id));
    if (!covered) warnings.push(`acceptance criterion ${ac.id} has no test case`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validatePlaywright(
  bundle: PlaywrightBundle,
  suite: TestCaseSuite,
  ticketKey: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (bundle.ticket_key !== ticketKey) errors.push(`ticket_key must be ${ticketKey}`);
  const files = bundle.files ?? [];
  if (bundle.readiness === "READY" && (bundle.missing_information ?? []).length) {
    errors.push("readiness=READY is not allowed while missing_information is non-empty");
  }
  if (bundle.readiness !== "NOT_APPLICABLE" && !files.length) {
    errors.push("a Playwright bundle must contain at least one file");
  }
  if (bundle.readiness === "NOT_APPLICABLE" && (bundle.traces ?? []).length) {
    errors.push("readiness=NOT_APPLICABLE means nothing was automated, so there can be no traces");
  }
  for (const file of files) {
    const p = file.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!p) errors.push("Playwright file path must not be empty");
    if (p.split("/").includes("..")) errors.push(`Playwright file path must not traverse upwards: ${p}`);
    if (!p.endsWith(".ts") && !p.endsWith(".js")) errors.push(`Playwright file must be .ts or .js, got ${p}`);
  }
  const knownTc = new Set((suite.test_cases ?? []).map((c) => c.id));
  for (const trace of bundle.traces ?? []) {
    if (!knownTc.has(trace.test_case_id)) {
      warnings.push(`trace for ${trace.test_name} references unknown test case ${trace.test_case_id}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
