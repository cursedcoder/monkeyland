import type { BeadsTask } from "./types";

/**
 * PM Validation: Validates task breakdowns created by Project Manager agents.
 * 
 * Two validators:
 * 1. DAG Validator (code-based, deterministic) - structural checks
 * 2. Sequencing Validator (LLM-based) - semantic dependency checks
 */

// --- Types ---

export interface DAGValidationResult {
  valid: boolean;
  hasCycles: boolean;
  cycleDetails?: string[];
  missingDeps: string[];
  orphanTasks: string[];
  missingParentId: string[];
  errors: string[];
}

export interface SequencingIssue {
  taskId: string;
  shouldDependOn: string;
  reason: string;
}

export interface SequencingValidationResult {
  valid: boolean;
  missingSequences: SequencingIssue[];
  reasons: string[];
}

export interface PMValidationResult {
  dagValidation: DAGValidationResult;
  sequencingValidation?: SequencingValidationResult;
  allPassed: boolean;
}

// --- DAG Validator (deterministic, code-based) ---

function normalizeDeps(task: BeadsTask): string[] {
  // Beads CLI may return dependencies in multiple formats:
  // 1. deps: string[] | string (simple list)
  // 2. blocked_by: string[] | string (simple list)
  // 3. dependencies: Array<{depends_on_id, type}> (structured, filter to "blocks" type only)
  
  // Try structured dependencies first (excludes parent-child relationships)
  if (task.dependencies && Array.isArray(task.dependencies)) {
    return task.dependencies
      .filter(d => d.type === "blocks")
      .map(d => d.depends_on_id)
      .filter(Boolean);
  }
  
  // Fall back to simple formats
  const deps = task.deps ?? task.blocked_by;
  if (!deps) return [];
  if (Array.isArray(deps)) return deps.map(d => d.trim()).filter(Boolean);
  return deps.split(",").map(d => d.trim()).filter(Boolean);
}

function detectCycles(tasks: BeadsTask[]): { hasCycles: boolean; cycleDetails: string[] } {
  const taskIds = new Set(tasks.map(t => t.id));
  const graph = new Map<string, string[]>();

  for (const task of tasks) {
    const deps = normalizeDeps(task);
    graph.set(task.id, deps.filter(d => taskIds.has(d)));
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const cycles: string[] = [];

  function dfs(nodeId: string, path: string[]): boolean {
    if (recursionStack.has(nodeId)) {
      const cycleStart = path.indexOf(nodeId);
      cycles.push(`Cycle detected: ${path.slice(cycleStart).join(" → ")} → ${nodeId}`);
      return true;
    }
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const neighbors = graph.get(nodeId) ?? [];
    for (const neighbor of neighbors) {
      if (dfs(neighbor, path)) {
        return true;
      }
    }

    path.pop();
    recursionStack.delete(nodeId);
    return false;
  }

  for (const taskId of taskIds) {
    if (!visited.has(taskId)) {
      dfs(taskId, []);
    }
  }

  return { hasCycles: cycles.length > 0, cycleDetails: cycles };
}

function findMissingDeps(tasks: BeadsTask[]): string[] {
  const taskIds = new Set(tasks.map(t => t.id));
  const missing: string[] = [];

  for (const task of tasks) {
    const deps = normalizeDeps(task);
    for (const dep of deps) {
      if (!taskIds.has(dep)) {
        missing.push(`Task ${task.id} references non-existent dependency: ${dep}`);
      }
    }
  }

  return missing;
}

function findOrphanTasks(tasks: BeadsTask[], _epicId: string | undefined): string[] {
  if (tasks.length <= 1) return [];

  const orphans: string[] = [];
  let hasFirstTask = false;

  for (const task of tasks) {
    const deps = normalizeDeps(task);
    
    if (deps.length === 0) {
      if (!hasFirstTask) {
        hasFirstTask = true;
      } else {
        orphans.push(`Task ${task.id} has no dependencies but is not the first task. ` +
          `Every task except the first should have deps to ensure proper sequencing.`);
      }
    }
  }

  return orphans;
}

function findMissingParentId(tasks: BeadsTask[], epicId: string | undefined): string[] {
  if (!epicId) return [];

  const missing: string[] = [];

  for (const task of tasks) {
    // Beads CLI may return 'parent', 'parent_id', or 'parentId' depending on version
    const parentId = task.parent ?? task.parent_id ?? task.parentId;
    if (!parentId) {
      missing.push(`Task ${task.id} is missing parent_id. Should be set to epic ID: ${epicId}`);
    } else if (parentId !== epicId) {
      missing.push(`Task ${task.id} has parent_id "${parentId}" but should reference epic "${epicId}"`);
    }
  }

  return missing;
}

/**
 * DAG Validator: Performs deterministic structural checks on the task graph.
 * 
 * Checks:
 * 1. No dependency cycles
 * 2. All dep references exist
 * 3. Every non-first task has dependencies
 * 4. All tasks have parent_id pointing to the epic
 */
export function validateDAG(tasks: BeadsTask[], epicId?: string): DAGValidationResult {
  if (tasks.length === 0) {
    return {
      valid: false,
      hasCycles: false,
      missingDeps: [],
      orphanTasks: [],
      missingParentId: [],
      errors: ["No tasks to validate"],
    };
  }

  const cycleResult = detectCycles(tasks);
  const missingDeps = findMissingDeps(tasks);
  const orphanTasks = findOrphanTasks(tasks, epicId);
  const missingParentId = findMissingParentId(tasks, epicId);

  const errors: string[] = [];
  if (cycleResult.hasCycles) {
    errors.push(...cycleResult.cycleDetails);
  }
  if (missingDeps.length > 0) {
    errors.push(...missingDeps);
  }
  if (orphanTasks.length > 0) {
    errors.push(...orphanTasks);
  }
  if (missingParentId.length > 0) {
    errors.push(...missingParentId);
  }

  return {
    valid: errors.length === 0,
    hasCycles: cycleResult.hasCycles,
    cycleDetails: cycleResult.cycleDetails,
    missingDeps,
    orphanTasks,
    missingParentId,
    errors,
  };
}

// --- Sequencing Validator (LLM-based) ---

/**
 * System prompt for the sequencing validator LLM.
 */
export const SEQUENCING_VALIDATOR_PROMPT = `You are a Sequencing Validator for a software development task breakdown.

Your job is to identify MISSING dependencies between tasks. A missing dependency occurs when Task B logically requires Task A to be completed first, but Task B does not list Task A in its dependencies.

## Common Sequencing Errors to Catch

1. **Install before scaffold**: Installing dependencies (npm install, pip install) before the project structure exists
2. **Code before structure**: Writing application code before directory structure is created
3. **Test before implementation**: Writing tests before the code they test exists
4. **Integration before components**: Integrating components before they are built
5. **Deploy before build**: Deployment tasks before build/compilation tasks
6. **Config after code**: Configuration that code depends on being set up after the code

## Input Format

You will receive a JSON array of tasks with their IDs, titles, descriptions, and current dependencies.

## Output Format

Respond with ONLY this JSON (no markdown fences, no other text):
{
  "missing_sequences": [
    {
      "task_id": "bd-xxx",
      "should_depend_on": "bd-yyy",
      "reason": "Brief explanation of why this dependency is needed"
    }
  ]
}

If no missing sequences are found, return:
{
  "missing_sequences": []
}

## Rules

- Only flag CLEAR sequencing errors where one task genuinely cannot start before another completes
- Do NOT flag stylistic preferences or optional orderings
- When in doubt, do NOT flag - false positives are worse than false negatives
- Consider that tasks may be intentionally parallel if they touch different areas`;

/**
 * Builds the user prompt for the sequencing validator.
 */
export function buildSequencingValidatorPrompt(tasks: BeadsTask[]): string {
  const taskSummaries = tasks.map(t => ({
    id: t.id,
    title: t.title,
    description: t.description?.slice(0, 500) ?? "(no description)",
    deps: normalizeDeps(t),
  }));

  return `Review these tasks for missing dependencies:

${JSON.stringify(taskSummaries, null, 2)}

Identify any tasks that should depend on other tasks but don't.`;
}

/**
 * Parses the LLM response from the sequencing validator.
 */
export function parseSequencingValidatorResponse(rawText: string): SequencingValidationResult {
  const cleaned = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  
  try {
    let parsed: { missing_sequences?: Array<{ task_id: string; should_depend_on: string; reason: string }> };
    
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } else {
        throw new Error("No JSON found");
      }
    }

    const missingSequences: SequencingIssue[] = (parsed.missing_sequences ?? []).map(s => ({
      taskId: s.task_id,
      shouldDependOn: s.should_depend_on,
      reason: s.reason,
    }));

    const reasons = missingSequences.map(s => 
      `Task ${s.taskId} should depend on ${s.shouldDependOn}: ${s.reason}`
    );

    return {
      valid: missingSequences.length === 0,
      missingSequences,
      reasons,
    };
  } catch {
    return {
      valid: false,
      missingSequences: [],
      reasons: ["Failed to parse sequencing validator response"],
    };
  }
}

// --- Combined PM Validation ---

/**
 * Runs the DAG validator. The sequencing validator should be run separately
 * via LLM call since it requires async processing.
 */
export function runPMValidation(
  tasks: BeadsTask[],
  epicId?: string,
  sequencingResult?: SequencingValidationResult
): PMValidationResult {
  const dagValidation = validateDAG(tasks, epicId);
  
  const allPassed = dagValidation.valid && (sequencingResult?.valid ?? true);

  return {
    dagValidation,
    sequencingValidation: sequencingResult,
    allPassed,
  };
}

/**
 * Formats PM validation results into a human-readable summary for the PM agent.
 */
export function formatPMValidationFeedback(result: PMValidationResult): string {
  const lines: string[] = [];

  if (result.allPassed) {
    lines.push("✓ Task breakdown validation passed.");
    return lines.join("\n");
  }

  lines.push("✗ Task breakdown validation failed. Issues found:\n");

  if (!result.dagValidation.valid) {
    lines.push("## DAG Structure Issues\n");
    for (const error of result.dagValidation.errors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  if (result.sequencingValidation && !result.sequencingValidation.valid) {
    lines.push("## Missing Dependencies\n");
    for (const issue of result.sequencingValidation.missingSequences) {
      lines.push(`- Task ${issue.taskId} should depend on ${issue.shouldDependOn}`);
      lines.push(`  Reason: ${issue.reason}`);
    }
    lines.push("");
  }

  lines.push("Please fix these issues and yield for review again.");

  return lines.join("\n");
}
