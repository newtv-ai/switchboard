// REST client + types for workgroups. Mirrors the server's shapes
// (packages/core/src/workgroup.ts + packages/server/src/cli-scanner.ts).

export type MemberRole = 'active' | 'observer' | 'idle';

export interface AgentMember {
  sessionId: string;
  adapterId: string;
  role: MemberRole;
  joinedAt: string;
}

export interface Workgroup {
  id: string;
  name: string;
  cwd: string;
  contextDir: string;
  createdAt: string;
  members: AgentMember[];
}

export interface WorkgroupSummary {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  memberCount: number;
}

export interface CliScanResult {
  adapterId: string;
  displayName: string;
  command?: string;
  path?: string;
  version?: string;
  hasAdapter: boolean;
  status: 'available' | 'missing' | 'error';
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const POST = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function listWorkgroups(): Promise<WorkgroupSummary[]> {
  return fetch('/api/workgroups').then((r) => json<WorkgroupSummary[]>(r));
}

export function getWorkgroup(id: string): Promise<Workgroup> {
  return fetch(`/api/workgroups/${id}`).then((r) => json<Workgroup>(r));
}

export function createWorkgroup(name: string, cwd: string): Promise<Workgroup> {
  return fetch('/api/workgroups', POST({ name, cwd })).then((r) => json<Workgroup>(r));
}

export function addMember(id: string, adapterId: string): Promise<AgentMember> {
  return fetch(`/api/workgroups/${id}/members`, POST({ adapterId })).then((r) =>
    json<AgentMember>(r),
  );
}

export function setMemberRole(id: string, sessionId: string, role: MemberRole): Promise<unknown> {
  return fetch(`/api/workgroups/${id}/members/${sessionId}/role`, POST({ role })).then((r) =>
    json<unknown>(r),
  );
}

export function removeMember(id: string, sessionId: string): Promise<unknown> {
  return fetch(`/api/workgroups/${id}/members/${sessionId}`, { method: 'DELETE' }).then((r) =>
    json<unknown>(r),
  );
}

export function scanClis(): Promise<CliScanResult[]> {
  return fetch('/api/scan').then((r) => json<CliScanResult[]>(r));
}

// ─── Tasks ───────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'blocked';

export interface Task {
  id: string;
  workgroupId: string;
  title: string;
  description: string;
  assignee?: string;
  status: TaskStatus;
  createdAt: string;
  assignedAt?: string;
  completedAt?: string;
  result?: string;
}

export interface PeekResult {
  sessionId: string;
  lines: number;
  text: string;
}

export function listTasks(id: string): Promise<Task[]> {
  return fetch(`/api/workgroups/${id}/tasks`).then((r) => json<Task[]>(r));
}

export function createTask(id: string, title: string, description: string): Promise<Task> {
  return fetch(`/api/workgroups/${id}/tasks`, POST({ title, description })).then((r) =>
    json<Task>(r),
  );
}

export function assignTask(id: string, taskId: string, sessionId: string): Promise<Task> {
  return fetch(`/api/workgroups/${id}/tasks/${taskId}/assign`, POST({ sessionId })).then((r) =>
    json<Task>(r),
  );
}

export function setTaskStatus(
  id: string,
  taskId: string,
  status: TaskStatus,
  result?: string,
): Promise<Task> {
  return fetch(`/api/workgroups/${id}/tasks/${taskId}/status`, POST({ status, result })).then((r) =>
    json<Task>(r),
  );
}

export function peekSession(sessionId: string, lines = 40): Promise<PeekResult> {
  return fetch(`/api/sessions/${sessionId}/peek?lines=${lines}`).then((r) => json<PeekResult>(r));
}

// ─── Workflow (four-step SOP) ──────────────────────────────────────────────

export type WorkflowPhase = 'planning' | 'execution' | 'audit' | 'bugfix' | 'done';

export interface Workflow {
  workgroupId: string;
  phase: WorkflowPhase;
  startedAt: string;
  updatedAt: string;
}

export function getWorkflow(id: string): Promise<Workflow | null> {
  return fetch(`/api/workgroups/${id}/workflow`).then((r) => json<Workflow | null>(r));
}

// POST with no body → no Content-Type header → Fastify runs the handler (no 415).
export function startWorkflow(id: string): Promise<Workflow> {
  return fetch(`/api/workgroups/${id}/workflow/start`, { method: 'POST' }).then((r) =>
    json<Workflow>(r),
  );
}

export function advanceWorkflow(id: string): Promise<Workflow> {
  return fetch(`/api/workgroups/${id}/workflow/advance`, { method: 'POST' }).then((r) =>
    json<Workflow>(r),
  );
}

// ─── Handoff (idea #9) ─────────────────────────────────────────────────────

export function handoff(
  id: string,
  fromSessionId: string,
  toSessionId: string,
  note?: string,
): Promise<unknown> {
  return fetch(`/api/workgroups/${id}/handoff`, POST({ fromSessionId, toSessionId, note })).then(
    (r) => json<unknown>(r),
  );
}
