// JSON schema builders derived from the model contracts — used for both the
// provider schema rung and the prompt-injected schema.

export function requirementSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ticket_key: { type: "string" },
      summary: { type: "string" },
      issue_type: { type: "string" },
      status: { type: "string" },
      priority: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      components: { type: "array", items: { type: "string" } },
      parent: { type: ["string", "null"] },
      subtasks: { type: "array", items: { type: "string" } },
      linked_issues: { type: "array", items: { type: "string" } },
      description_summary: { type: "string" },
      requirements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            provenance: { enum: ["EXPLICIT", "INFERRED", "MISSING", "ASSUMPTION_REQUIRING_CONFIRMATION"] },
            source_quote: { type: "string" },
            category: { type: "string" },
          },
          required: ["id", "text", "provenance"],
        },
      },
      acceptance_criteria: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            provenance: { enum: ["EXPLICIT", "INFERRED", "MISSING", "ASSUMPTION_REQUIRING_CONFIRMATION"] },
            source_quote: { type: "string" },
            requirement_ids: { type: "array", items: { type: "string" } },
          },
          required: ["id", "text"],
        },
      },
      business_rules: { type: "array", items: { type: "string" } },
      non_functional_requirements: { type: "array", items: { type: "string" } },
      dependencies: { type: "array", items: { type: "string" } },
      constraints: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      missing_information: { type: "array", items: { type: "string" } },
      open_questions: { type: "array", items: { type: "string" } },
    },
    required: ["ticket_key", "summary", "requirements", "acceptance_criteria"],
  };
}

export function testPlanSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ticket_key: { type: "string" },
      title: { type: "string" },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: { type: "integer", minimum: 1, maximum: 12 },
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["number", "title", "content"],
        },
      },
      scenarios: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            requirement_ids: { type: "array", items: { type: "string" } },
            acceptance_criteria_ids: { type: "array", items: { type: "string" } },
            priority: { enum: ["P0", "P1", "P2", "P3"] },
          },
          required: ["id", "title"],
        },
      },
    },
    required: ["ticket_key", "title", "sections", "scenarios"],
  };
}

export function testCasesSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ticket_key: { type: "string" },
      coverage_notes: { type: "string" },
      test_cases: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            ticket_key: { type: "string" },
            title: { type: "string" },
            objective: { type: "string" },
            priority: { enum: ["P0", "P1", "P2", "P3"] },
            test_type: {
              enum: ["happy_path", "negative", "boundary", "validation", "error_handling",
                "state_transition", "permissions", "data_integrity", "api_contract",
                "accessibility", "cross_browser", "regression", "recovery"],
            },
            requirement_ids: { type: "array", items: { type: "string" } },
            acceptance_criteria_ids: { type: "array", items: { type: "string" } },
            preconditions: { type: "array", items: { type: "string" } },
            test_data: { type: "array", items: { type: "string" } },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: { number: { type: "integer" }, action: { type: "string" }, expected: { type: "string" } },
                required: ["number", "action"],
              },
            },
            expected_result: { type: "string" },
            automation_candidate: { enum: ["Yes", "No", "Partial"] },
            automation_rationale: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            assumptions_or_blockers: { type: "array", items: { type: "string" } },
          },
          required: ["id", "ticket_key", "title", "steps"],
        },
      },
    },
    required: ["ticket_key", "test_cases"],
  };
}

export function playwrightSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ticket_key: { type: "string" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            kind: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      traces: {
        type: "array",
        items: {
          type: "object",
          properties: {
            test_name: { type: "string" },
            test_case_id: { type: "string" },
            ticket_key: { type: "string" },
            requirement_ids: { type: "array", items: { type: "string" } },
            acceptance_criteria_ids: { type: "array", items: { type: "string" } },
            spec_path: { type: "string" },
          },
          required: ["test_name", "test_case_id", "ticket_key"],
        },
      },
      readiness: { enum: ["READY", "NEEDS_CONFIGURATION", "NOT_APPLICABLE"] },
      setup_notes: { type: "string" },
      missing_information: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
    },
    required: ["ticket_key", "files"],
  };
}
