import { useCallback, useEffect, useState } from 'react';
import {
  type CliScanResult,
  type MemberRole,
  type Task,
  type Workflow,
  type Workgroup,
  addMember,
  advanceWorkflow,
  assignTask,
  createTask,
  getWorkflow,
  getWorkgroup,
  handoff,
  listTasks,
  peekSession,
  removeMember,
  scanClis,
  setMemberRole,
  setTaskStatus,
  startWorkflow,
} from './workgroups-api.js';
import { WS_BASE } from './ws-url.js';

export interface WorkgroupViewProps {
  id: string;
  onAttach(sessionId: string): void;
  onBack(): void;
}

const ROLES: MemberRole[] = ['active', 'observer', 'idle'];
const PHASES = ['planning', 'execution', 'audit', 'bugfix', 'done'] as const;

export function WorkgroupView({ id, onAttach, onBack }: WorkgroupViewProps): JSX.Element {
  const [wg, setWg] = useState<Workgroup | null>(null);
  const [scan, setScan] = useState<CliScanResult[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [assignSel, setAssignSel] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState<{ sessionId: string; text: string } | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [handoffFrom, setHandoffFrom] = useState<string | null>(null);
  const [handoffTo, setHandoffTo] = useState('');
  const [handoffNote, setHandoffNote] = useState('');

  const refresh = useCallback(async () => {
    try {
      // The workgroup itself is critical — if it fails, show the error view.
      setWg(await getWorkgroup(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load workgroup');
      return;
    }
    // The rest degrade independently: a transient failure here must not wedge
    // the whole view. Re-scanning here also lets the Refresh button recover an
    // earlier empty/failed scan.
    listTasks(id)
      .then(setTasks)
      .catch(() => {});
    getWorkflow(id)
      .then(setWorkflow)
      .catch(() => {});
    scanClis()
      .then(setScan)
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live updates: subscribe to this workgroup and refresh on any change
  // (from this client, another client, or an agent). Reconnect with backoff.
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const connect = (): void => {
      ws = new WebSocket(`${WS_BASE}/workgroups/ws`);
      ws.onopen = () => {
        attempts = 0;
        ws?.send(JSON.stringify({ type: 'subscribe', workgroupId: id }));
      };
      ws.onmessage = (e: MessageEvent<string>) => {
        try {
          const m = JSON.parse(e.data) as { type?: string };
          if (m.type === 'workgroup.changed') refresh();
        } catch {
          // ignore non-JSON frames
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        const delay = Math.min(1000 * 2 ** attempts, 10000);
        attempts += 1;
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [id, refresh]);

  const wrap = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'action failed');
    } finally {
      setBusy(false);
    }
  };

  const cycleRole = (sessionId: string, role: MemberRole): Promise<void> => {
    const next = ROLES[(ROLES.indexOf(role) + 1) % ROLES.length] ?? 'active';
    return wrap(() => setMemberRole(id, sessionId, next));
  };

  const addTask = (): Promise<void> => {
    if (!title.trim() && !desc.trim()) return Promise.resolve();
    return wrap(async () => {
      await createTask(id, title, desc);
      setTitle('');
      setDesc('');
    });
  };

  const dispatch = (taskId: string): Promise<void> => {
    // `||` (not `??`) so the empty-string placeholder also falls back to member[0].
    const sessionId = assignSel[taskId] || wg?.members[0]?.sessionId;
    if (!sessionId) {
      setError('Add a member first, then dispatch.');
      return Promise.resolve();
    }
    return wrap(() => assignTask(id, taskId, sessionId));
  };

  const doPeek = async (sessionId: string): Promise<void> => {
    try {
      const r = await peekSession(sessionId, 40);
      setPeek({ sessionId, text: r.text });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'peek failed');
    }
  };

  const doHandoff = (): Promise<void> => {
    if (!handoffFrom || !handoffTo) {
      setError('Pick a target member to hand off to.');
      return Promise.resolve();
    }
    const from = handoffFrom;
    const to = handoffTo;
    const note = handoffNote;
    return wrap(async () => {
      await handoff(id, from, to, note);
      setHandoffFrom(null);
      setHandoffTo('');
      setHandoffNote('');
    });
  };

  if (!wg) {
    return (
      <div className="list-view">
        <header>
          <button type="button" className="btn btn-files" onClick={onBack}>
            ← Back
          </button>
          <h1>Workgroup</h1>
        </header>
        <main>
          <p className="empty-hint">{error ?? 'Loading…'}</p>
        </main>
      </div>
    );
  }

  const available = scan.filter((s) => s.status === 'available');
  const memberLabel = (sessionId: string): string =>
    wg.members.find((m) => m.sessionId === sessionId)?.adapterId ?? sessionId.slice(0, 8);

  return (
    <div className="list-view">
      <header>
        <button type="button" className="btn btn-files" onClick={onBack}>
          ← Back
        </button>
        <h1>{wg.name}</h1>
        <button type="button" className="btn btn-files" onClick={refresh}>
          Refresh
        </button>
      </header>

      <main>
        <p className="session-meta">
          <span className="session-cwd" title={wg.cwd}>
            {wg.cwd}
          </span>
        </p>
        {error && <p className="empty-hint">{error}</p>}

        <h2 style={{ marginTop: '1rem' }}>Workflow (SOP)</h2>
        <div className="session-card">
          <div
            className="session-card-row session-meta"
            style={{ flexWrap: 'wrap', gap: '0.4rem' }}
          >
            {PHASES.map((ph) => (
              <span
                key={ph}
                className={`session-state ${workflow?.phase === ph ? 'state-running' : ''}`}
              >
                {ph}
              </span>
            ))}
          </div>
          <div className="session-card-row session-meta">
            {!workflow && (
              <button
                type="button"
                className="btn btn-small"
                disabled={busy}
                onClick={() => wrap(() => startWorkflow(id))}
              >
                Start
              </button>
            )}
            {workflow && workflow.phase !== 'done' && (
              <button
                type="button"
                className="btn btn-small"
                disabled={busy}
                onClick={() => wrap(() => advanceWorkflow(id))}
              >
                Advance →
              </button>
            )}
            {workflow && (
              <button
                type="button"
                className="btn btn-small"
                disabled={busy}
                onClick={() => wrap(() => startWorkflow(id))}
              >
                Restart
              </button>
            )}
          </div>
        </div>

        <h2 style={{ marginTop: '1rem' }}>Members</h2>
        {wg.members.length === 0 ? (
          <p className="empty-hint">No members yet. Add an AI below — it starts in this folder.</p>
        ) : (
          <ul className="session-list">
            {wg.members.map((m) => (
              <li key={m.sessionId}>
                <div className="session-card">
                  <div className="session-card-row">
                    <span className="session-name">{m.adapterId}</span>
                    <button
                      type="button"
                      className={`session-state state-${m.role}`}
                      onClick={() => cycleRole(m.sessionId, m.role)}
                      title="Tap to change role (active → observer → idle)"
                    >
                      {m.role}
                    </button>
                  </div>
                  <div className="session-card-row session-meta">
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => onAttach(m.sessionId)}
                    >
                      Open terminal
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => doPeek(m.sessionId)}
                    >
                      Peek
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        setHandoffFrom(m.sessionId);
                        setHandoffTo('');
                      }}
                    >
                      Handoff
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => wrap(() => removeMember(id, m.sessionId))}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {peek && (
          <div className="session-card" style={{ marginTop: '0.5rem' }}>
            <div className="session-card-row">
              <span className="session-name">Peek: {memberLabel(peek.sessionId)}</span>
              <button type="button" className="btn btn-small" onClick={() => setPeek(null)}>
                Close
              </button>
            </div>
            <pre
              style={{ whiteSpace: 'pre-wrap', maxHeight: '12rem', overflow: 'auto', margin: 0 }}
            >
              {peek.text || '(no output)'}
            </pre>
          </div>
        )}

        {handoffFrom && (
          <div className="session-card" style={{ marginTop: '0.5rem' }}>
            <div className="session-card-row">
              <span className="session-name">Hand off from {memberLabel(handoffFrom)}</span>
              <button type="button" className="btn btn-small" onClick={() => setHandoffFrom(null)}>
                Cancel
              </button>
            </div>
            <div
              className="session-card-row session-meta"
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.4rem' }}
            >
              <select
                aria-label="Hand off to member"
                value={handoffTo}
                onChange={(e) => setHandoffTo(e.target.value)}
              >
                <option value="">(pick target member)</option>
                {wg.members
                  .filter((m) => m.sessionId !== handoffFrom)
                  .map((m) => (
                    <option key={m.sessionId} value={m.sessionId}>
                      {m.adapterId}
                    </option>
                  ))}
              </select>
              <textarea
                placeholder="Handoff note — what's done, what's next"
                value={handoffNote}
                onChange={(e) => setHandoffNote(e.target.value)}
                rows={3}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !handoffTo}
                onClick={doHandoff}
                style={{ alignSelf: 'flex-start' }}
              >
                Confirm handoff
              </button>
            </div>
          </div>
        )}

        <h2 style={{ marginTop: '1.5rem' }}>Add an AI (runs in this folder)</h2>
        {available.length === 0 ? (
          <p className="empty-hint">
            No AI CLIs detected. Scan from the session list’s “Agents” button first.
          </p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {available.map((s) => (
              <button
                key={s.adapterId}
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => wrap(() => addMember(id, s.adapterId))}
              >
                + {s.displayName}
                {s.version ? ` v${s.version}` : ''}
              </button>
            ))}
          </div>
        )}

        <h2 style={{ marginTop: '1.5rem' }}>Tasks</h2>
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}
        >
          <input
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            placeholder="Description — what should the AI do?"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={3}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={addTask}
            disabled={busy}
            style={{ alignSelf: 'flex-start' }}
          >
            + Add task
          </button>
        </div>

        {tasks.length === 0 ? (
          <p className="empty-hint">No tasks yet.</p>
        ) : (
          <ul className="session-list">
            {tasks.map((t) => (
              <li key={t.id}>
                <div className="session-card">
                  <div className="session-card-row">
                    <span className="session-name">{t.title}</span>
                    <span className={`session-state state-${t.status}`}>{t.status}</span>
                  </div>
                  {t.assignee && (
                    <div className="session-card-row session-meta">
                      <span className="session-adapter">→ {memberLabel(t.assignee)}</span>
                    </div>
                  )}
                  <div className="session-card-row session-meta" style={{ flexWrap: 'wrap' }}>
                    <select
                      aria-label="Assign to member"
                      value={assignSel[t.id] ?? ''}
                      onChange={(e) =>
                        setAssignSel((prev) => ({ ...prev, [t.id]: e.target.value }))
                      }
                    >
                      <option value="">(pick member)</option>
                      {wg.members.map((m) => (
                        <option key={m.sessionId} value={m.sessionId}>
                          {m.adapterId}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy || wg.members.length === 0}
                      onClick={() => dispatch(t.id)}
                    >
                      Dispatch
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => wrap(() => setTaskStatus(id, t.id, 'done'))}
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => wrap(() => setTaskStatus(id, t.id, 'failed'))}
                    >
                      Fail
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
