/**
 * Workgroup model — several agent sessions sharing one project folder and one
 * on-disk shared-context directory. Pure data types; the orchestration logic
 * (spawning members, persistence) lives in the server's WorkgroupManager.
 */

export type MemberRole = 'active' | 'observer' | 'idle';

export interface AgentMember {
  /** The underlying Session id (see SessionManager). */
  sessionId: string;
  adapterId: string;
  role: MemberRole;
  /** ISO timestamp. */
  joinedAt: string;
}

export interface Workgroup {
  id: string;
  name: string;
  /** Project folder; members are spawned here ("start the CLI in this folder"). */
  cwd: string;
  /** Shared-context directory on disk (~/.switchboard/workgroups/<id>/). */
  contextDir: string;
  /** ISO timestamp. */
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

export function summarizeWorkgroup(wg: Workgroup): WorkgroupSummary {
  return {
    id: wg.id,
    name: wg.name,
    cwd: wg.cwd,
    createdAt: wg.createdAt,
    memberCount: wg.members.length,
  };
}
