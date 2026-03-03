export type CheckResult = { status: "pass" | "fail"; reasons: string[]; out_of_scope_files?: string[] };
export type ParsedValidatorResults = {
  code_review: CheckResult;
  business_logic: CheckResult;
  scope: CheckResult;
  visual?: CheckResult;
};

export function getValidatorSpawnFailureSubmissions(developerAgentId: string): Array<{
  developer_agent_id: string;
  validator_role: "code_review" | "business_logic" | "scope";
  pass: false;
  reasons: string[];
}> {
  const reasons = ["Validator failed to spawn"];
  return [
    { developer_agent_id: developerAgentId, validator_role: "code_review", pass: false, reasons },
    { developer_agent_id: developerAgentId, validator_role: "business_logic", pass: false, reasons },
    { developer_agent_id: developerAgentId, validator_role: "scope", pass: false, reasons },
  ];
}

function failedResult(reason: string): CheckResult {
  return { status: "fail", reasons: [reason] };
}

function normalizeStatus(status: string): "pass" | "fail" {
  return status.toLowerCase() === "pass" ? "pass" : "fail";
}

function normalizeCheck(check: CheckResult): CheckResult {
  return { ...check, status: normalizeStatus(check.status) };
}

export function normalizeValidatorOutput(rawText: string): ParsedValidatorResults {
  const cleaned = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  let parsed: Partial<ParsedValidatorResults> = {};
  try {
    parsed = JSON.parse(cleaned) as Partial<ParsedValidatorResults>;
  } catch {
    // LLM may have emitted text around the JSON — extract the outermost { ... }
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Partial<ParsedValidatorResults>;
      } catch {
        return {
          code_review: failedResult("Could not parse validator output"),
          business_logic: failedResult("Could not parse validator output"),
          scope: failedResult("Could not parse validator output"),
        };
      }
    } else {
      return {
        code_review: failedResult("Could not parse validator output"),
        business_logic: failedResult("Could not parse validator output"),
        scope: failedResult("Could not parse validator output"),
      };
    }
  }

  const out: ParsedValidatorResults = {
    code_review: normalizeCheck(parsed.code_review ?? failedResult("Missing validator result for code_review")),
    business_logic: normalizeCheck(parsed.business_logic ?? failedResult("Missing validator result for business_logic")),
    scope: normalizeCheck(parsed.scope ?? failedResult("Missing validator result for scope")),
  };
  if (parsed.visual) out.visual = normalizeCheck(parsed.visual);
  return out;
}
