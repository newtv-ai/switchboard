import { join } from 'node:path';
import { readJson, writeJson } from './fs-json.js';
import { appendTimeline } from './shared-context.js';
import type { TaskManager } from './task-manager.js';
import { PHASE_TEMPLATES, type Workflow, type WorkflowPhase, nextPhase } from './workflow.js';
import type { WorkgroupManager } from './workgroup-manager.js';
import { workgroupDir } from './workgroup-store.js';

/**
 * Drives a workgroup through the four-step SOP. start()/advance() move the phase
 * and create that phase's templated task; the user then dispatches it like any
 * other task. State persists to ~/.switchboard/workgroups/<id>/workflow.json.
 */
export class WorkflowManager {
  private readonly flows = new Map<string, Workflow>();

  constructor(
    private readonly workgroups: WorkgroupManager,
    private readonly tasks: TaskManager,
  ) {}

  async init(): Promise<void> {
    for (const wg of this.workgroups.list()) {
      const wf = await this.load(wg.id);
      if (wf) this.flows.set(wg.id, wf);
    }
  }

  get(workgroupId: string): Workflow | undefined {
    return this.flows.get(workgroupId);
  }

  /** Start (or restart) the SOP at the planning phase and create its task. */
  async start(workgroupId: string): Promise<Workflow> {
    this.requireGroup(workgroupId);
    const now = new Date().toISOString();
    const wf: Workflow = { workgroupId, phase: 'planning', startedAt: now, updatedAt: now };
    this.flows.set(workgroupId, wf);
    await this.save(wf);
    await this.spawnPhaseTask(workgroupId, 'planning');
    await this.event(workgroupId, 'workflow.started', { phase: 'planning' });
    return wf;
  }

  /** Advance to the next phase and create that phase's task. */
  async advance(workgroupId: string): Promise<Workflow> {
    const wf = this.require(workgroupId);
    const phase = nextPhase(wf.phase);
    wf.phase = phase;
    wf.updatedAt = new Date().toISOString();
    await this.save(wf);
    if (phase !== 'done') await this.spawnPhaseTask(workgroupId, phase);
    await this.event(workgroupId, 'workflow.advanced', { phase });
    return wf;
  }

  private async spawnPhaseTask(
    workgroupId: string,
    phase: Exclude<WorkflowPhase, 'done'>,
  ): Promise<void> {
    const tpl = PHASE_TEMPLATES[phase];
    await this.tasks.create(
      workgroupId,
      tpl.title,
      `${tpl.description}\n\n(Suggested assignee: ${tpl.assigneeHint}.)`,
    );
  }

  private require(workgroupId: string): Workflow {
    const wf = this.flows.get(workgroupId);
    if (!wf) throw new Error(`No workflow for workgroup: ${workgroupId}`);
    return wf;
  }

  private requireGroup(workgroupId: string): void {
    if (!this.workgroups.get(workgroupId)) throw new Error(`Unknown workgroup: ${workgroupId}`);
  }

  private async event(
    workgroupId: string,
    type: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const wg = this.workgroups.get(workgroupId);
    if (wg) await appendTimeline(wg.contextDir, { ts: new Date().toISOString(), type, ...extra });
  }

  private filePath(workgroupId: string): string {
    return join(workgroupDir(workgroupId), 'workflow.json');
  }

  private async load(workgroupId: string): Promise<Workflow | undefined> {
    return (await readJson<Workflow | null>(this.filePath(workgroupId), null)) ?? undefined;
  }

  private save(wf: Workflow): Promise<void> {
    return writeJson(this.filePath(wf.workgroupId), wf);
  }
}
