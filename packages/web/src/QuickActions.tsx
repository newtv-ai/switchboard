// Mobile virtual keyboards don't have Esc, Tab, arrow keys, or Ctrl chords;
// this toolbar surfaces them as taps. Each button sends the raw ANSI bytes
// that xterm-flavoured PTYs expect — same sequences a real keyboard would
// produce — so the receiving side (claude code, codex, etc.) sees no
// difference between a hardware Esc and a tap on this Esc.

const KEY_BYTES = {
  Esc: '\x1b',
  Tab: '\t',
  'Shift+Tab': '\x1b[Z',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Left: '\x1b[D',
  Right: '\x1b[C',
  'Ctrl+C': '\x03',
  // Ctrl+L is the traditional "redraw" signal. Ink-based TUIs (claude code,
  // codex) listen for it and emit a full re-render, clearing any stale diffs
  // left behind by resize/modal-dismiss churn on mobile.
  'Ctrl+L': '\x0c',
} as const;

type ActionKey = keyof typeof KEY_BYTES;

const ACTIONS: Array<{ label: string; key: ActionKey }> = [
  { label: 'Esc', key: 'Esc' },
  { label: 'Tab', key: 'Tab' },
  { label: '⇧Tab', key: 'Shift+Tab' },
  { label: '↑', key: 'Up' },
  { label: '↓', key: 'Down' },
  { label: '←', key: 'Left' },
  { label: '→', key: 'Right' },
  { label: '^C', key: 'Ctrl+C' },
  // Force redraw — clears stale modal residue after Esc on mobile.
  { label: '↻', key: 'Ctrl+L' },
];

export interface QuickActionsProps {
  onSend(data: string): void;
}

export function QuickActions({ onSend }: QuickActionsProps): JSX.Element {
  return (
    <div className="quick-actions" role="toolbar" aria-label="Terminal shortcuts">
      {ACTIONS.map((a) => (
        <button
          key={a.key}
          type="button"
          className="qa-btn"
          // onPointerDown + preventDefault keeps focus on the xterm helper
          // textarea so the keyboard doesn't dismiss between taps.
          onPointerDown={(e) => {
            e.preventDefault();
            onSend(KEY_BYTES[a.key]);
          }}
          aria-label={a.key}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
