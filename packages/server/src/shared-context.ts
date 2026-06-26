import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shared-context directory for a workgroup, materialized inside the project folder
 * as `<cwd>/.switchboard/` (the consensus approach — cf. CCB's `.ccb/`). Members
 * spawned in the folder read/write these files directly; Markdown is the
 * cross-agent protocol. Per-file writes are serialized so concurrent members
 * can't corrupt a shared file.
 */

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create `<contextDir>/` + artifacts/ and scaffold the shared files. Idempotent —
 * never clobbers a file that already exists, so accumulated context survives.
 */
export async function ensureContextDir(contextDir: string, contextSeed?: string): Promise<void> {
  await mkdir(join(contextDir, 'artifacts'), { recursive: true });
  const files: Record<string, string> = {
    'context.md':
      contextSeed ??
      '# Shared context\n\n_Agents read this on entry. Keep it the current source of truth._\n',
    'decisions.md': '# Decisions\n\n| when | who | decision |\n|---|---|---|\n',
    'handoff.md': '# Handoff notes\n\n_Used when handing a task from one agent to another._\n',
  };
  for (const [name, body] of Object.entries(files)) {
    const p = join(contextDir, name);
    if (!(await exists(p))) await writeFile(p, body, 'utf8');
  }
  const timeline = join(contextDir, 'timeline.jsonl');
  if (!(await exists(timeline))) await writeFile(timeline, '', 'utf8');
}

const BLOCK_BEGIN = '<!-- switchboard:workgroup:begin -->';
const BLOCK_END = '<!-- switchboard:workgroup:end -->';

function instructionBlock(): string {
  return [
    BLOCK_BEGIN,
    '## Switchboard workgroup',
    'You are a member of a multi-agent workgroup sharing this folder. Before starting, read',
    '`.switchboard/context.md` (shared context) and `.switchboard/decisions.md`, and check',
    "`.switchboard/artifacts/` for other members' outputs. Write your own products to",
    '`.switchboard/artifacts/` and record decisions in `.switchboard/decisions.md`.',
    BLOCK_END,
  ].join('\n');
}

/** Insert or replace the managed switchboard block in one instruction file. */
async function upsertManagedBlock(path: string, block: string): Promise<void> {
  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch {
    // file doesn't exist yet — it will be created
  }
  const begin = content.indexOf(BLOCK_BEGIN);
  const end = content.indexOf(BLOCK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    content = `${content.slice(0, begin)}${block}${content.slice(end + BLOCK_END.length)}`;
  } else {
    content = content.trim() ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }
  await writeFile(path, content, 'utf8');
}

/**
 * Make agents auto-discover the shared context by pointing their project
 * instruction files (AGENTS.md for codex/etc., CLAUDE.md for Claude Code) at
 * `.switchboard/`. Uses a clearly-marked, idempotent managed block so it's safe
 * to re-run and leaves the user's own content untouched.
 */
export async function ensureAgentInstructions(cwd: string): Promise<void> {
  const block = instructionBlock();
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    await upsertManagedBlock(join(cwd, file), block);
  }
}

// One promise chain per file path → serialized writes (single-writer queue).
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  chains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export interface TimelineEvent {
  ts: string;
  type: string;
  [k: string]: unknown;
}

/** Append one structured event to the workgroup timeline (serialized). */
export function appendTimeline(contextDir: string, event: TimelineEvent): Promise<void> {
  const p = join(contextDir, 'timeline.jsonl');
  return serialize(p, () => appendFile(p, `${JSON.stringify(event)}\n`, 'utf8'));
}

/** Append a Markdown entry to the workgroup handoff log (serialized). */
export function appendHandoff(contextDir: string, markdown: string): Promise<void> {
  const p = join(contextDir, 'handoff.md');
  return serialize(p, () => appendFile(p, markdown, 'utf8'));
}
