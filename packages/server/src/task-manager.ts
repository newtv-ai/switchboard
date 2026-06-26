import { randomUUID } from 'node:crypto';
import type { SessionManager } from '@switchboard/core';
import { appendTimeline } from './shared-context.js';
import type { Task, TaskStatus, TaskStore } from './task-store.js';
import type { WorkgroupManager } from './workgroup-manager.js';

/**
 * Tasks within a workgroup. Dispatch = write the task to the assigned member's
 * PTY stdin (the assigned agent then works in the shared folder, reading/writing
 * `.switchboard/`). The agent is already running and at its prompt when the user
 * dispatches, so this is just "type the task and press Enter" on their behalf.
 */
export class TaskManager {
  private readonly byGroup = new Map<string, Task[]>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly workgroups: WorkgroupManager,
    private readonly store: TaskStore,
  ) {}

  async init(): Promise<void> {
    for (const wg of this.workgroups.list()) {
      this.byGroup.set(wg.id, await this.store.load(wg.id));
    }
  }

  list(workgroupId: string): Task[] {
    return this.byGroup.get(workgroupId) ?? [];
  }

  async create(workgroupId: string, title: string, description: string): Promise<Task> {
    const wg = this.requireGroup(workgroupId);
    const task: Task = {
      id: randomUUID().slice(0, 8),
      workgroupId,
      title: title.trim() || 'Untitled task',
      description,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const tasks = this.list(workgroupId);
    tasks.push(task);
    this.byGroup.set(workgroupId, tasks);
    await this.store.save(workgroupId, tasks);
    await appendTimeline(wg.contextDir, {
      ts: task.createdAt,
      type: 'task.created',
      taskId: task.id,
      title: task.title,
    });
    return task;
  }

  /** Assign a task to a member session and dispatch it to that session's stdin. */
  async assign(workgroupId: string, taskId: string, sessionId: string): Promise<Task> {
    const wg = this.requireGroup(workgroupId);
    const task = this.requireTask(workgroupId, taskId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    task.assignee = sessionId;
    task.assignedAt = new Date().toISOString();
    task.status = 'running';

    // Collapse to a single line: a TUI submits on the first newline, so a
    // multi-line description sent as-is would dispatch only the first line.
    const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const msg = `${oneLine(task.title)}: ${oneLine(task.description)} (shared context in .switchboard/context.md; write results to .switchboard/artifacts/, decisions to .switchboard/decisions.md)`;
    session.write(`${msg}\r`);

    await this.store.save(workgroupId, this.list(workgroupId));
    await appendTimeline(wg.contextDir, {
      ts: task.assignedAt,
      type: 'task.assigned',
      taskId,
      sessionId,
    });
    return task;
  }

  async setStatus(
    workgroupId: string,
    taskId: string,
    status: TaskStatus,
    result?: string,
  ): Promise<Task> {
    const wg = this.requireGroup(workgroupId);
    const task = this.requireTask(workgroupId, taskId);
    task.status = status;
    if (result !== undefined) task.result = result;
    if (status === 'done' || status === 'failed') task.completedAt = new Date().toISOString();
    await this.store.save(workgroupId, this.list(workgroupId));
    await appendTimeline(wg.contextDir, {
      ts: new Date().toISOString(),
      type: 'task.status',
      taskId,
      status,
    });
    return task;
  }

  private requireGroup(workgroupId: string): { contextDir: string } {
    const wg = this.workgroups.get(workgroupId);
    if (!wg) throw new Error(`Unknown workgroup: ${workgroupId}`);
    return wg;
  }

  private requireTask(workgroupId: string, taskId: string): Task {
    const task = this.list(workgroupId).find((t) => t.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }
}
