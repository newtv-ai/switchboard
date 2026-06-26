/**
 * Four-step SOP (ideas #5–#8): planning → execution → audit → bugfix. Kept lean —
 * a workflow is just a phase tracker that, on entering each phase, creates a
 * phase-templated Task (via TaskManager). The actual work still flows through the
 * normal task dispatch; this layer only guides the sequence.
 */

export type WorkflowPhase = 'planning' | 'execution' | 'audit' | 'bugfix' | 'done';

export interface Workflow {
  workgroupId: string;
  phase: WorkflowPhase;
  startedAt: string;
  updatedAt: string;
}

/** Ordered phases; 'done' is terminal. */
export const PHASES: readonly WorkflowPhase[] = [
  'planning',
  'execution',
  'audit',
  'bugfix',
  'done',
];

export interface PhaseTemplate {
  title: string;
  description: string;
  /** Human hint about who should take it (surfaced in UI, not enforced). */
  assigneeHint: string;
}

export const PHASE_TEMPLATES: Record<Exclude<WorkflowPhase, 'done'>, PhaseTemplate> = {
  planning: {
    title: 'Planning — discuss the approach',
    description:
      'Read .switchboard/context.md. Discuss and agree the approach, then write the chosen plan to .switchboard/decisions.md and break it into concrete tasks.',
    assigneeHint: 'all active members',
  },
  execution: {
    title: 'Execution — implement the plan',
    description:
      'Implement the plan from .switchboard/decisions.md. Put diffs / reports into .switchboard/artifacts/.',
    assigneeHint: 'the implementing member',
  },
  audit: {
    title: 'Audit — review the changes',
    description:
      'Review the execution-phase changes (see .switchboard/artifacts/). List issues with severity and write the findings to .switchboard/artifacts/audit-report.md.',
    assigneeHint: 'a member who did NOT execute (cross-audit)',
  },
  bugfix: {
    title: 'Bugfix — address audit findings',
    description:
      'Fix the issues listed in .switchboard/artifacts/audit-report.md, then re-check the changed files.',
    assigneeHint: 'the implementing member',
  },
};

export function nextPhase(phase: WorkflowPhase): WorkflowPhase {
  const i = PHASES.indexOf(phase);
  return PHASES[Math.min(i + 1, PHASES.length - 1)] ?? 'done';
}
