import { join } from 'node:path';
import { readJson, writeJson } from './fs-json.js';
import { workgroupDir } from './workgroup-store.js';

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'blocked';

export interface Task {
  id: string;
  workgroupId: string;
  title: string;
  description: string;
  /** Assigned member's session id. */
  assignee?: string;
  status: TaskStatus;
  createdAt: string;
  assignedAt?: string;
  completedAt?: string;
  /** Short summary of the outcome (written by a human or an agent). */
  result?: string;
}

/** Persists a workgroup's tasks to ~/.switchboard/workgroups/<id>/tasks.json. */
export class TaskStore {
  load(workgroupId: string): Promise<Task[]> {
    return readJson<Task[]>(join(workgroupDir(workgroupId), 'tasks.json'), []);
  }

  save(workgroupId: string, tasks: Task[]): Promise<void> {
    return writeJson(join(workgroupDir(workgroupId), 'tasks.json'), tasks);
  }
}
