// Traceability and coverage — faithful TS port of services/traceability.py

import type {
  CoverageReport,
  CoverageStatus,
  PlaywrightBundle,
  RequirementAnalysis,
  TestCase,
  TestCaseSuite,
  TraceabilityRow,
} from "./models";

export function buildCoverage(
  analysis: RequirementAnalysis,
  suite: TestCaseSuite | null,
  bundle: PlaywrightBundle | null
): CoverageReport {
  const cases: TestCase[] = suite?.test_cases ?? [];
  const automatedIds = new Set(
    (bundle?.traces ?? []).map((t) => t.test_case_id)
  );

  const rows: TraceabilityRow[] = [];
  const coveredReq = new Set<string>();
  const partialReq = new Set<string>();
  const coveredAc = new Set<string>();
  const orphanReq: string[] = [];
  const orphanAc: string[] = [];
  const orphanTc: string[] = [];
  const unknownRefs = new Set<string>();

  const knownReq = new Set((analysis.requirements ?? []).map((r) => r.id));
  const knownAc = new Set((analysis.acceptance_criteria ?? []).map((c) => c.id));

  for (const req of analysis.requirements ?? []) {
    const matching = cases.filter((tc) =>
      (tc.requirement_ids ?? []).includes(req.id)
    );
    const automated = matching.filter((tc) => automatedIds.has(tc.id));
    let status: CoverageStatus = "UNCOVERED";
    let reason = "";
    if (matching.length) {
      coveredReq.add(req.id);
      status = "COVERED";
      if (matching.some((tc) => !automatedIds.has(tc.id))) {
        status = "PARTIAL";
        partialReq.add(req.id);
      }
    } else {
      orphanReq.push(req.id);
      reason = "no test case references this requirement";
    }
    rows.push({
      requirement_id: req.id,
      requirement_text: req.text,
      acceptance_criterion_id: "",
      acceptance_criterion_text: "",
      test_case_ids: matching.map((tc) => tc.id),
      automated_test_case_ids: automated.map((tc) => tc.id),
      coverage_status: status,
      reason,
    });
  }

  for (const ac of analysis.acceptance_criteria ?? []) {
    const matching = cases.filter((tc) =>
      (tc.acceptance_criteria_ids ?? []).includes(ac.id)
    );
    if (matching.length) coveredAc.add(ac.id);
    else orphanAc.push(ac.id);
    // Attach to the requirement row when the AC verifies a requirement.
    for (const rid of ac.requirement_ids ?? []) {
      const row = rows.find((r) => r.requirement_id === rid);
      if (row) {
        row.acceptance_criterion_id = ac.id;
        row.acceptance_criterion_text = ac.text;
      }
    }
  }

  for (const tc of cases) {
    const refs = [...(tc.requirement_ids ?? []), ...(tc.acceptance_criteria_ids ?? [])];
    const known = refs.some((r) => knownReq.has(r) || knownAc.has(r));
    if (!known) orphanTc.push(tc.id);
    for (const ref of refs) {
      if (!knownReq.has(ref) && !knownAc.has(ref)) unknownRefs.add(ref);
    }
  }

  return {
    ticket_key: analysis.ticket_key,
    rows,
    total_requirements: (analysis.requirements ?? []).length,
    covered_requirements: coveredReq.size,
    partially_covered_requirements: partialReq.size,
    uncovered_requirements: (analysis.requirements ?? []).length - coveredReq.size,
    total_acceptance_criteria: (analysis.acceptance_criteria ?? []).length,
    covered_acceptance_criteria: coveredAc.size,
    total_test_cases: cases.length,
    automated_test_cases: automatedIds.size,
    orphan_requirement_ids: orphanReq,
    orphan_acceptance_criteria_ids: orphanAc,
    orphan_test_case_ids: orphanTc,
    unknown_reference_ids: [...unknownRefs].sort(),
  };
}

export function warnOnCoverage(c: CoverageReport): string[] {
  const warnings: string[] = [];
  if (c.orphan_requirement_ids.length) {
    warnings.push(`[Coverage] Requirements with no test case: ${c.orphan_requirement_ids.join(", ")}`);
  }
  if (c.orphan_acceptance_criteria_ids.length) {
    warnings.push(`[Coverage] Acceptance criteria with no test case: ${c.orphan_acceptance_criteria_ids.join(", ")}`);
  }
  if (c.orphan_test_case_ids.length) {
    warnings.push(`[Coverage] Test cases that trace to nothing: ${c.orphan_test_case_ids.join(", ")}`);
  }
  if (c.unknown_reference_ids.length) {
    warnings.push(`[Coverage] References to ids that do not exist: ${c.unknown_reference_ids.join(", ")}`);
  }
  return warnings;
}
