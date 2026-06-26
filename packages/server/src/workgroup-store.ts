import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Workgroup } from '@switchboard/core';
import { readJson, writeJson } from './fs-json.js';

/** Base dir where workgroup metadata + shared-context registry live. */
export function workgroupsBaseDir(): string {
  return join(homedir(), '.switchboard', 'workgroups');
}

/** Per-workgroup registry dir (holds workgroup.json, tasks.json, workflow.json). */
export function workgroupDir(id: string): string {
  return join(workgroupsBaseDir(), id);
}

/**
 * Persists workgroup metadata to ~/.switchboard/workgroups/<id>/workgroup.json.
 * Survives a server restart (PTY sessions do not — see SPEC §9 — so members are
 * pruned on load by the manager).
 */
export class WorkgroupStore {
  private readonly base = workgroupsBaseDir();

  save(wg: Workgroup): Promise<void> {
    return writeJson(join(workgroupDir(wg.id), 'workgroup.json'), wg);
  }

  async loadAll(): Promise<Workgroup[]> {
    let entries: string[];
    try {
      entries = await readdir(this.base);
    } catch {
      return []; // base dir doesn't exist yet
    }
    const groups: Workgroup[] = [];
    for (const id of entries) {
      const wg = await readJson<Workgroup | null>(join(this.base, id, 'workgroup.json'), null);
      if (wg) groups.push(wg);
    }
    return groups;
  }
}
