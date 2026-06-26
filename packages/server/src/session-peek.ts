import type { Session } from '@switchboard/core';

// ESC / BEL come from fromCharCode (not regex literals) to keep the pattern free
// of literal control characters.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * Strips ANSI CSI / OSC / simple escapes. Best-effort: a session's ring buffer
 * is a stream of TUI redraws, not the rendered screen, so peek output is an
 * APPROXIMATION of recent activity — enough to glance at what a peer agent is
 * doing, not a faithful transcript.
 */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}|${ESC}.`, 'g');

/** Return the last `lines` lines of a session's output, ANSI-stripped (approximate). */
export function peekSession(session: Session, lines: number): string {
  const text = session.getReplay().toString('utf8').replace(ANSI, '');
  const all = text.split(/\r?\n/);
  return all.slice(-Math.max(1, lines)).join('\n');
}
