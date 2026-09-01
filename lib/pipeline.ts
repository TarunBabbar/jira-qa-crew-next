// Pipeline orchestration — faithful TS port of services/pipeline.py

import type { Settings } from "./config";
import { blockingProblems, llmReady, redact } from "./config";
import { JiraRestProvider } from "./jira";
import { CommandCodeLlm } from "./llm";
import type {
  JiraIssue,
  PlaywrightBundle,
  RequirementAnalysis,
  RunSummary,
  StageName,
  TestCaseSuite,
  TestPlan,
  TicketResult,
} from "./models";
import {
  newStageSet,
  issueToPromptText,
  TEST_PLAN_SECTIONS,
  requirementCoveragePct,
} from "./models";
import {
  ANALYSIS_DESCRIPTION,
  TEST_CASES_DESCRIPTION,
  TEST_PLAN_DESCRIPTION,
  PLAYWRIGHT_DESCRIPTION,
  AGENTS,
  analysisHandoff,
  casesHandoff,
  planHandoff,
} from "./prompts";
import { playwrightSchema, requirementSchema, testCasesSchema, testPlanSchema } from "./schema";
import { buildCoverage, warnOnCoverage } from "./traceability";
import { validateAnalysis, validatePlaywright, validateTestCases, validateTestPlan } from "./validation";

export function newRunId(now = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    "RUN-" +
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

const LENGTHY_RESPONSE_CHARS = 3000;
const MAX_CALLS_PER_ATTEMPT = 4;

function newRunSummary(): RunSummary {
  return {
    run_id: newRunId(),
    requested_keys: [],
    invalid_inputs: [],
    duplicates_removed: [],
    results: [],
    started_at: new Date().toISOString(),
    finished_at: null,
  };
}

export type ProgressCallback = (ticketKey: string, stage: StageName, status: string, message: string) => void;

export class QAPipeline {
  private llm: CommandCodeLlm;
  private jira: JiraRestProvider;

  constructor(private settings: Settings, private progress?: ProgressCallback) {
    this.llm = new CommandCodeLlm(settings);
    this.jira = new JiraRestProvider(settings);
  }

  private emit(ticketKey: string, stage: StageName, status: string, message: string) {
    this.progress?.(ticketKey, stage, status, message);
  }

  async run(ticketKeys: string[]): Promise<RunSummary> {
    const run = newRunSummary();
    run.requested_keys = ticketKeys.map((k) => k.trim().toUpperCase());

    for (const key of run.requested_keys) {
      const result: TicketResult = {
        ticket_key: key,
        status: "PENDING",
        source: null,
        issue: null,
        analysis: null,
        test_plan: null,
        test_cases: null,
        playwright: null,
        coverage: null,
        stages: newStageSet(),
        warnings: [],
        error: "",
        started_at: null,
        finished_at: null,
      };
      run.results.push(result);
      try {
        await this.runTicket(result);
      } catch (e) {
        result.status = "FAILED";
        result.error = redact(this.settings, `${(e as Error).name}: ${e}`);
      } finally {
        result.finished_at = new Date().toISOString();
      }
    }
    run.finished_at = new Date().toISOString();
    return run;
  }

  private async runTicket(result: TicketResult): Promise<void> {
    const key = result.ticket_key;
    result.started_at = new Date().toISOString();
    result.status = "RUNNING";

    // Stage 0: fetch
    const fetchStage = result.stages.find((s) => s.stage === "Jira Fetch")!;
    fetchStage.status = "RUNNING";
    fetchStage.message = `Fetching ${key} from Jira`;
    this.emit(key, "Jira Fetch", "RUNNING", `Fetching ${key} from Jira`);
    let issue: JiraIssue;
    try {
      issue = await this.jira.fetchIssue(key);
    } catch (e) {
      fetchStage.status = "FAILED";
      fetchStage.message = redact(this.settings, `${e}`);
      this.emit(key, "Jira Fetch", "FAILED", fetchStage.message);
      result.status = "FAILED";
      result.error = redact(this.settings, `${e}`);
      return;
    }
    result.issue = issue;
    result.source = issue.source;
    fetchStage.status = "COMPLETED";
    fetchStage.message = `Fetched via ${issue.source}`;
    fetchStage.started_at = new Date().toISOString();
    fetchStage.finished_at = new Date().toISOString();
    this.emit(key, "Jira Fetch", "COMPLETED", `Fetched via ${issue.source}`);

    if (!llmReady(this.settings)) {
      const message = "LLM is not configured, so no artifacts can be generated.";
      result.status = "FAILED";
      result.error = message;
      for (const s of result.stages) {
        if (s.stage !== "Jira Fetch") { s.status = "FAILED"; s.message = message; }
      }
      return;
    }

    // Stage 1: analysis
    const analysis = await this.stage<RequirementAnalysis>({
      result,
      stageName: "Jira Analyst",
      buildPrompt: () =>
        ANALYSIS_DESCRIPTION
          .replaceAll("{ticket_key}", key)
          .replaceAll("{source}", issue.source)
          .replaceAll("{issue_text}", issueToPromptText(issue)),
      schema: requirementSchema(),
      validate: (obj) => validateAnalysis(obj, key),
      repair: null,
    });

    // Stage 2: test plan
    const plan = await this.stage<TestPlan>({
      result,
      stageName: "Test Plan Writer",
      buildPrompt: () => {
        const sections = TEST_PLAN_SECTIONS.map((t, i) => `    ${i + 1}. ${t}`).join("\n");
        return TEST_PLAN_DESCRIPTION
          .replaceAll("{ticket_key}", key)
          .replaceAll("{section_list}", sections)
          + "\n\n" + analysisHandoff(analysis);
      },
      schema: testPlanSchema(),
      validate: (obj) => validateTestPlan(obj, analysis, key),
      repair: null,
    });

    // Stage 3: test cases
    const suite = await this.stage<TestCaseSuite>({
      result,
      stageName: "Test Case Writer",
      buildPrompt: () =>
        TEST_CASES_DESCRIPTION
          .replaceAll("{ticket_key}", key)
          .replaceAll("{requirement_ids}", (analysis.requirements ?? []).map((r) => r.id).join(", ") || "(none extracted)")
          .replaceAll("{acceptance_criteria_ids}", (analysis.acceptance_criteria ?? []).map((c) => c.id).join(", ") || "(none stated in the ticket)")
          + "\n\n" + analysisHandoff(analysis)
          + "\n\n" + planHandoff(plan),
      schema: testCasesSchema(),
      validate: (obj) => validateTestCases(obj, analysis, key),
      repair: null,
    });

    // Stage 4: playwright
    const bundle = await this.stage<PlaywrightBundle>({
      result,
      stageName: "Playwright Coder",
      buildPrompt: () =>
        PLAYWRIGHT_DESCRIPTION
          .replaceAll("{ticket_key}", key)
          .replaceAll("{spec_filename}", `${key.toLowerCase().replaceAll("_", "-")}.spec.ts`)
          + "\n\n" + casesHandoff(suite),
      schema: playwrightSchema(),
      validate: (obj) => validatePlaywright(obj, suite, key),
      repair: null,
    });

    result.analysis = analysis;
    result.test_plan = plan;
    result.test_cases = suite;
    result.playwright = bundle;

    // Coverage
    const artifactStage = result.stages.find((s) => s.stage === "Artifacts")!;
    artifactStage.status = "RUNNING";
    artifactStage.message = "Computing coverage";
    this.emit(key, "Artifacts", "RUNNING", "Computing coverage");
    result.coverage = buildCoverage(analysis, suite, bundle);
    result.warnings.push(...warnOnCoverage(result.coverage));
    artifactStage.status = "COMPLETED";
    artifactStage.message = `${result.coverage.total_test_cases} test cases, ${requirementCoveragePct(result.coverage)}% requirement coverage`;
    artifactStage.started_at = new Date().toISOString();
    artifactStage.finished_at = new Date().toISOString();
    this.emit(key, "Artifacts", "COMPLETED", artifactStage.message);

    result.status = result.warnings.length ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
  }

  private async stage<T>(opts: {
    result: TicketResult;
    stageName: StageName;
    buildPrompt: () => string;
    schema: Record<string, unknown>;
    validate: (obj: T) => { ok: boolean; errors: string[]; warnings: string[] };
    repair: ((problems: string[]) => string) | null;
  }): Promise<T> {
    const stage = opts.result.stages.find((s) => s.stage === opts.stageName)!;
    stage.status = "RUNNING";
    stage.message = `${opts.stageName} running`;
    stage.started_at = new Date().toISOString();
    this.emit(opts.result.ticket_key, opts.stageName, "RUNNING", `${opts.stageName} running`);

    const agent = AGENTS[agentKeyForStage(opts.stageName)];
    const system = `You are ${agent.role}.\n\nGoal: ${agent.goal}\n\n${agent.backstory}`;

    let obj: T | null = null;
    let validation: { ok: boolean; errors: string[]; warnings: string[] };

    // First attempt
    obj = await this.executeAndValidate<T>(system, opts.buildPrompt(), opts.schema, opts.validate);
    validation = obj === null
      ? { ok: false, errors: ["structured output could not be parsed"], warnings: [] }
      : opts.validate(obj);

    // One repair attempt
    if (obj === null || !validation.ok) {
      const problems = validation.errors;
      stage.message = `${opts.stageName} output rejected, one repair attempt`;
      this.emit(opts.result.ticket_key, opts.stageName, "RUNNING", `${opts.stageName} output rejected, one repair attempt`);
      const repairPrompt = opts.buildPrompt() + appendRepairInstruction(problems);
      obj = await this.executeAndValidate<T>(system, repairPrompt, opts.schema, opts.validate);
      validation = obj === null
        ? { ok: false, errors: problems, warnings: [] }
        : opts.validate(obj);
    }

    if (obj === null || !validation.ok) {
      const message = validation.errors.join("; ") || "no valid structured output";
      stage.status = "FAILED";
      stage.message = redact(this.settings, message);
      stage.finished_at = new Date().toISOString();
      this.emit(opts.result.ticket_key, opts.stageName, "FAILED", stage.message);
      throw new Error(`${opts.stageName} did not return a valid result: ${message}`);
    }

    for (const warning of validation.warnings) {
      opts.result.warnings.push(`[${opts.stageName}] ${warning}`);
    }
    stage.status = validation.warnings.length ? "WARNING" : "COMPLETED";
    stage.message = `${opts.stageName} completed` + (validation.warnings.length ? ` with ${validation.warnings.length} warning(s)` : "");
    stage.finished_at = new Date().toISOString();
    this.emit(opts.result.ticket_key, opts.stageName, stage.status, stage.message);
    return obj;
  }

  private async executeAndValidate<T>(
    system: string,
    user: string,
    schema: Record<string, unknown>,
    validate: (obj: T) => { ok: boolean; errors: string[]; warnings: string[] }
  ): Promise<T | null> {
    const maxEmpty = Math.max(1, this.settings.pipelineMaxRetries);
    let emptyAttempts = 0;
    let calls = 0;
    let allowSchema = true;
    let allowJson = true;

    // Ladder: schema -> json_object -> plain (mirrors _execute_and_validate)
    const rungs: Array<"schema" | "json" | "plain"> = ["schema", "json", "plain"];
    let i = 0;
    while (i < rungs.length && calls < MAX_CALLS_PER_ATTEMPT) {
      const rung = rungs[i];
      if (rung === "schema" && !allowSchema) { i++; continue; }
      if (rung === "json" && !allowJson) { i++; continue; }
      calls++;
      try {
        const parsed = await this.llm.generateJson<T>(system, user, schema, {
          allowSchema: rung === "schema" && allowSchema,
          allowJsonObject: rung === "json" && allowJson,
        });
        if (parsed === null) return null;
        const validation = validate(parsed);
        if (validation.ok) return parsed;
        // Repair is handled by the caller; here we return the unvalidated obj.
        return parsed;
      } catch (e) {
        const msg = String(e);
        if (rung === "schema" && /response_format|json_schema|structured output/.test(msg) && msg.includes("400")) {
          allowSchema = false;
          i++;
          continue;
        }
        if (rung === "json" && /response_format|json_schema|structured output/.test(msg) && msg.includes("400")) {
          allowJson = false;
          i++;
          continue;
        }
        if (/none or empty|invalid response from llm call|empty response/i.test(msg)) {
          if (emptyAttempts < maxEmpty) {
            emptyAttempts++;
            await new Promise((r) => setTimeout(r, Math.min(2 ** emptyAttempts, 8) * 1000));
            continue; // retry same rung
          }
          i++;
          emptyAttempts = 0;
          continue;
        }
        throw e;
      }
    }
    return null;
  }
}

function appendRepairInstruction(problems: string[]): string {
  const marker = "\n\n### CORRECTION REQUIRED (single retry)\n";
  const bullets = problems.slice(0, 10).map((p) => `- ${p}`).join("\n");
  return (
    `${marker}` +
    "Your previous attempt was rejected by deterministic validation:\n" +
    `${bullets}\n` +
    "Fix exactly these problems and return the same structured object. " +
    "Do not invent new content to satisfy a check: if information is genuinely missing, " +
    "record it in the missing-information field instead of fabricating it."
  );
}

function agentKeyForStage(stage: StageName): string {
  switch (stage) {
    case "Jira Analyst": return "jira_analyst";
    case "Test Plan Writer": return "test_plan_writer";
    case "Test Case Writer": return "test_case_writer";
    case "Playwright Coder": return "playwright_coder";
    default: return "jira_analyst";
  }
}

// Export for the route
export { blockingProblems };
