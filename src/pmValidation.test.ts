import { describe, it, expect } from 'vitest';
import {
  validateDAG,
  parseSequencingValidatorResponse,
  buildSequencingValidatorPrompt,
  runPMValidation,
  formatPMValidationFeedback,
} from './pmValidation';
import type { BeadsTask } from './types';

describe('validateDAG', () => {
  it('returns valid for a proper task chain', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Setup project', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Install deps', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-1'] },
      { id: 'bd-3', title: 'Build UI', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-2'] },
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(true);
    expect(result.hasCycles).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it('detects dependency cycles', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-3'] },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-1'] },
      { id: 'bd-3', title: 'Task 3', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-2'] },
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(false);
    expect(result.hasCycles).toBe(true);
    expect(result.cycleDetails?.length).toBeGreaterThan(0);
  });

  it('detects missing dependencies', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-999'] },
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(false);
    expect(result.missingDeps.length).toBeGreaterThan(0);
    expect(result.missingDeps[0]).toContain('bd-999');
  });

  it('detects orphan tasks (no deps when not first)', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-1' }, // No deps - orphan!
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(false);
    expect(result.orphanTasks.length).toBeGreaterThan(0);
    expect(result.orphanTasks[0]).toContain('bd-2');
  });

  it('allows parallel tasks with shared dependency', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Setup', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Build A', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-1'] },
      { id: 'bd-3', title: 'Build B', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-1'] },
      { id: 'bd-4', title: 'Integrate', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-2', 'bd-3'] },
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(true);
  });

  it('detects missing parent_id', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', deps: ['bd-1'] }, // No parent_id
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(false);
    expect(result.missingParentId.length).toBeGreaterThan(0);
    expect(result.missingParentId[0]).toContain('bd-2');
  });

  it('detects wrong parent_id', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-2', deps: ['bd-1'] }, // Wrong parent
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(false);
    expect(result.missingParentId.length).toBeGreaterThan(0);
  });

  it('returns invalid for empty task list', () => {
    const result = validateDAG([], 'epic-1');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('No tasks to validate');
  });

  it('handles deps as comma-separated string', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: 'bd-1' },
      { id: 'bd-3', title: 'Task 3', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: 'bd-1, bd-2' },
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(true);
  });

  it('handles dependencies array format from Beads CLI', () => {
    const tasks: BeadsTask[] = [
      {
        id: 'bd-1',
        title: 'Task 1',
        type: 'task',
        status: 'deferred',
        parent: 'epic-1',
        dependencies: [],
      },
      {
        id: 'bd-2',
        title: 'Task 2',
        type: 'task',
        status: 'deferred',
        parent: 'epic-1',
        dependencies: [
          { issue_id: 'bd-2', depends_on_id: 'bd-1', type: 'blocks' },
          { issue_id: 'bd-2', depends_on_id: 'epic-1', type: 'parent-child' },
        ],
      },
      {
        id: 'bd-3',
        title: 'Task 3',
        type: 'task',
        status: 'deferred',
        parent: 'epic-1',
        dependencies: [
          { issue_id: 'bd-3', depends_on_id: 'bd-2', type: 'blocks' },
          { issue_id: 'bd-3', depends_on_id: 'epic-1', type: 'parent-child' },
        ],
      },
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.valid).toBe(true);
    expect(result.hasCycles).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it('filters out parent-child from dependencies when checking for orphans', () => {
    const tasks: BeadsTask[] = [
      {
        id: 'bd-1',
        title: 'Task 1',
        type: 'task',
        status: 'deferred',
        parent: 'epic-1',
        dependencies: [
          { issue_id: 'bd-1', depends_on_id: 'epic-1', type: 'parent-child' },
        ],
      },
      {
        id: 'bd-2',
        title: 'Task 2',
        type: 'task',
        status: 'deferred',
        parent: 'epic-1',
        dependencies: [
          { issue_id: 'bd-2', depends_on_id: 'epic-1', type: 'parent-child' },
        ],
      },
    ];

    const result = validateDAG(tasks, 'epic-1');
    expect(result.orphanTasks.length).toBeGreaterThan(0);
    expect(result.orphanTasks[0]).toContain('bd-2');
  });
});

describe('parseSequencingValidatorResponse', () => {
  it('parses valid JSON with no issues', () => {
    const response = '{"missing_sequences": []}';
    const result = parseSequencingValidatorResponse(response);
    expect(result.valid).toBe(true);
    expect(result.missingSequences).toHaveLength(0);
  });

  it('parses JSON with missing sequences', () => {
    const response = JSON.stringify({
      missing_sequences: [
        {
          task_id: 'bd-2',
          should_depend_on: 'bd-1',
          reason: 'Cannot install deps before project exists',
        },
      ],
    });
    const result = parseSequencingValidatorResponse(response);
    expect(result.valid).toBe(false);
    expect(result.missingSequences).toHaveLength(1);
    expect(result.missingSequences[0].taskId).toBe('bd-2');
    expect(result.missingSequences[0].shouldDependOn).toBe('bd-1');
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const response = '```json\n{"missing_sequences": []}\n```';
    const result = parseSequencingValidatorResponse(response);
    expect(result.valid).toBe(true);
  });

  it('extracts JSON from surrounding text', () => {
    const response = 'Here is my analysis:\n{"missing_sequences": []}\nThat concludes my review.';
    const result = parseSequencingValidatorResponse(response);
    expect(result.valid).toBe(true);
  });

  it('returns invalid for unparseable response', () => {
    const response = 'This is not JSON at all';
    const result = parseSequencingValidatorResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('Failed to parse sequencing validator response');
  });
});

describe('buildSequencingValidatorPrompt', () => {
  it('builds a prompt with task summaries', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', description: 'First task' },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', description: 'Second task', deps: ['bd-1'] },
    ];

    const prompt = buildSequencingValidatorPrompt(tasks);
    expect(prompt).toContain('bd-1');
    expect(prompt).toContain('Task 1');
    expect(prompt).toContain('bd-2');
    expect(prompt).toContain('Task 2');
    expect(prompt).toContain('First task');
  });

  it('truncates long descriptions', () => {
    const longDesc = 'x'.repeat(1000);
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', description: longDesc },
    ];

    const prompt = buildSequencingValidatorPrompt(tasks);
    expect(prompt.length).toBeLessThan(longDesc.length + 500);
  });
});

describe('runPMValidation', () => {
  it('combines DAG and sequencing results - all pass', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-1'] },
    ];

    const result = runPMValidation(tasks, 'epic-1', { valid: true, missingSequences: [], reasons: [] });
    expect(result.allPassed).toBe(true);
    expect(result.dagValidation.valid).toBe(true);
    expect(result.sequencingValidation?.valid).toBe(true);
  });

  it('combines DAG and sequencing results - DAG fails', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-2'] },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-1'] },
    ];

    const result = runPMValidation(tasks, 'epic-1', { valid: true, missingSequences: [], reasons: [] });
    expect(result.allPassed).toBe(false);
    expect(result.dagValidation.valid).toBe(false);
  });

  it('combines DAG and sequencing results - sequencing fails', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-1'] },
    ];

    const seqResult = {
      valid: false,
      missingSequences: [{ taskId: 'bd-2', shouldDependOn: 'bd-1', reason: 'test' }],
      reasons: ['test issue'],
    };

    const result = runPMValidation(tasks, 'epic-1', seqResult);
    expect(result.allPassed).toBe(false);
    expect(result.dagValidation.valid).toBe(true);
    expect(result.sequencingValidation?.valid).toBe(false);
  });
});

describe('formatPMValidationFeedback', () => {
  it('returns success message when all passed', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
    ];
    const result = runPMValidation(tasks, 'epic-1');
    const feedback = formatPMValidationFeedback(result);
    expect(feedback).toContain('passed');
  });

  it('includes DAG errors when DAG fails', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-2'] },
      { id: 'bd-2', title: 'Task 2', type: 'task', status: 'deferred', parent_id: 'epic-1', deps: ['bd-1'] },
    ];
    const result = runPMValidation(tasks, 'epic-1');
    const feedback = formatPMValidationFeedback(result);
    expect(feedback).toContain('DAG');
    expect(feedback).toContain('Cycle');
  });

  it('includes sequencing errors when sequencing fails', () => {
    const tasks: BeadsTask[] = [
      { id: 'bd-1', title: 'Task 1', type: 'task', status: 'deferred', parent_id: 'epic-1' },
    ];
    const seqResult = {
      valid: false,
      missingSequences: [{ taskId: 'bd-2', shouldDependOn: 'bd-1', reason: 'Install before create' }],
      reasons: ['Task bd-2 should depend on bd-1: Install before create'],
    };
    const result = runPMValidation(tasks, 'epic-1', seqResult);
    const feedback = formatPMValidationFeedback(result);
    expect(feedback).toContain('Missing Dependencies');
    expect(feedback).toContain('bd-2');
  });
});
