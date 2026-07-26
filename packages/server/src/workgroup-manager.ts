import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  type AgentMember,
  type MemberRole,
  type SessionManager,
  type Workgroup,
  type WorkgroupSummary,
  summarizeWorkgroup,
} from '@switchboard/core';
import {
  appendHandoff,
  appendTimeline,
  ensureAgentInstructions,
  ensureContextDir,
} from './shared-context.js';
import type { WorkgroupStore } from './workgroup-store.js';

export interface WorkgroupMemberTarget {
  adapterId?: string;
  command?: string;
}

/**
 * Manages workgroups on top of the SessionManager. A workgroup is a thin layer:
 * members are ordinary Sessions referenced by id, plus a shared project folder
 * and a project-local shared-context dir (`<cwd>/.switchboard/`). Spawning a
 * member (Option B) starts a fresh CLI session in the workgroup's folder.
 *
 * Read-one project model: one workgroup per project folder (create() dedupes by
 * cwd and resumes the existing group, so a project's shared memory accumulates).
 */
export class WorkgroupManager {
  private readonly groups = new Map<string, Workgroup>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly store: WorkgroupStore,
  ) {}

  /**
   * Load persisted groups. PTY sessions don't survive a restart (SPEC §9), so
   * prune members whose session is gone — the group shell + the project-local
   * shared-context files persist; members are re-added.
   */
  async init(): Promise<void> {
    for (const wg of await this.store.loadAll()) {
      wg.members = wg.members.filter((m) => this.sessions.get(m.sessionId));
      this.groups.set(wg.id, wg);
    }
  }

  list(): WorkgroupSummary[] {
    return Array.from(this.groups.values()).map(summarizeWorkgroup);
  }

  get(id: string): Workgroup | undefined {
    return this.groups.get(id);
  }

  /**
   * Create a workgroup for a project folder — or resume the existing one bound to
   * that folder (dedupe by cwd). Materializes `<cwd>/.switchboard/` and points the
   * project's AGENTS.md/CLAUDE.md at it so members auto-read the shared context.
   */
  async create(name: string, cwd: string): Promise<Workgroup> {
    const dir = resolve(cwd);

    let isDir = false;
    try {
      isDir = (await stat(dir)).isDirectory();
    } catch {
      // folder doesn't exist
    }
    if (!isDir) throw new Error(`Project folder does not exist: ${dir}`);

    // Dedupe by folder (case-insensitive on Windows/macOS) so the same physical
    // directory maps to one workgroup and its shared memory accumulates.
    const ci = process.platform === 'win32' || process.platform === 'darwin';
    const norm = (s: string): string => (ci ? s.toLowerCase() : s);
    const existing = [...this.groups.values()].find((g) => norm(g.cwd) === norm(dir));
    if (existing) {
      await ensureContextDir(existing.contextDir, this.seedContext(existing));
      await ensureAgentInstructions(dir);
      return existing;
    }

    const id = randomUUID().slice(0, 8);
    const wg: Workgroup = {
      id,
      name: name.trim() || basename(dir) || `workgroup-${id}`,
      cwd: dir,
      contextDir: join(dir, '.switchboard'),
      createdAt: new Date().toISOString(),
      members: [],
    };
    await ensureContextDir(wg.contextDir, this.seedContext(wg));
    await ensureAgentInstructions(dir);
    await this.store.save(wg);
    this.groups.set(id, wg);
    await appendTimeline(wg.contextDir, {
      ts: wg.createdAt,
      type: 'workgroup.created',
      name: wg.name,
      cwd: dir,
    });
    return wg;
  }

  /** Option B: spawn a fresh CLI session in the workgroup's folder and add it. */
  async addMember(groupId: string, target: WorkgroupMemberTarget): Promise<AgentMember> {
    const wg = this.require(groupId);
    const adapterId = target.adapterId?.trim();
    const command = target.command?.trim();
    if ((!adapterId && !command) || (adapterId && command)) {
      throw new Error('Provide exactly one of adapterId or command');
    }
    const agentId = adapterId ?? command;
    if (!agentId) throw new Error('Adapter or command is required');
    const session = adapterId
      ? this.sessions.spawn({ adapterId, cwd: wg.cwd, name: `${agentId}@${wg.name}` })
      : this.sessions.spawnRaw({
          command: agentId,
          cwd: wg.cwd,
          name: `${agentId}@${wg.name}`,
        });
    const member: AgentMember = {
      sessionId: session.id,
      adapterId: agentId,
      role: 'active',
      joinedAt: new Date().toISOString(),
    };
    wg.members.push(member);
    await this.store.save(wg);
    await appendTimeline(wg.contextDir, {
      ts: member.joinedAt,
      type: 'member.joined',
      adapterId: agentId,
      sessionId: session.id,
    });
    return member;
  }

  async setRole(groupId: string, sessionId: string, role: MemberRole): Promise<void> {
    const wg = this.require(groupId);
    const member = wg.members.find((m) => m.sessionId === sessionId);
    if (!member) throw new Error(`Not a member: ${sessionId}`);
    member.role = role;
    await this.store.save(wg);
    await appendTimeline(wg.contextDir, {
      ts: new Date().toISOString(),
      type: 'member.role',
      sessionId,
      role,
    });
  }

  async removeMember(groupId: string, sessionId: string): Promise<void> {
    const wg = this.require(groupId);
    wg.members = wg.members.filter((m) => m.sessionId !== sessionId);
    await this.store.save(wg);
    await appendTimeline(wg.contextDir, {
      ts: new Date().toISOString(),
      type: 'member.left',
      sessionId,
    });
  }

  /**
   * Hand work off from one member to another (idea #9, manual): log a note to
   * handoff.md, flip roles (from→idle, to→active), and kick the target to read
   * the handoff + shared context and continue. No token auto-switch — the user
   * decides when to hand off.
   */
  async handoff(
    groupId: string,
    fromSessionId: string,
    toSessionId: string,
    note?: string,
  ): Promise<{ from: AgentMember; to: AgentMember }> {
    const wg = this.require(groupId);
    const from = wg.members.find((m) => m.sessionId === fromSessionId);
    const to = wg.members.find((m) => m.sessionId === toSessionId);
    if (!from || !to) throw new Error('Both from and to must be members');
    if (from === to) throw new Error('Cannot hand off to the same member');
    const toSession = this.sessions.get(toSessionId);
    if (!toSession) throw new Error(`Target session not running: ${toSessionId}`);

    const ts = new Date().toISOString();
    const body = note?.trim() ? note.trim() : '_(no note provided)_';
    await appendHandoff(
      wg.contextDir,
      `\n## ${ts} — ${from.adapterId} → ${to.adapterId}\n\n${body}\n`,
    );
    from.role = 'idle';
    to.role = 'active';
    await this.store.save(wg);
    toSession.write(
      `Taking over from ${from.adapterId}. Read .switchboard/handoff.md and .switchboard/context.md, then continue.\r`,
    );
    await appendTimeline(wg.contextDir, {
      ts,
      type: 'handoff',
      from: fromSessionId,
      to: toSessionId,
    });
    return { from, to };
  }

  private seedContext(wg: Workgroup): string {
    return [
      `# Shared context — ${wg.name}`,
      '',
      `- Project folder: ${wg.cwd}`,
      `- Workgroup id: ${wg.id}`,
      '',
      '## Goal',
      '_(Fill in what this workgroup is working on.)_',
      '',
      '## Notes for members',
      '- Read this file before starting; record decisions in decisions.md.',
      '- Write products (diffs, reports) into artifacts/ so peers can read them.',
      '',
    ].join('\n');
  }

  private require(id: string): Workgroup {
    const wg = this.groups.get(id);
    if (!wg) throw new Error(`Unknown workgroup: ${id}`);
    return wg;
  }
}
