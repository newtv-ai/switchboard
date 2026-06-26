import { useCallback, useEffect, useState } from 'react';
import { type WorkgroupSummary, createWorkgroup, listWorkgroups } from './workgroups-api.js';

export interface WorkgroupListProps {
  onOpen(id: string): void;
  onBack(): void;
}

export function WorkgroupList({ onOpen, onBack }: WorkgroupListProps): JSX.Element {
  const [groups, setGroups] = useState<WorkgroupSummary[]>([]);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setGroups(await listWorkgroups());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async (): Promise<void> => {
    if (!cwd.trim()) {
      setError('Project folder (cwd) is required — that’s where the AIs will run.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const wg = await createWorkgroup(name, cwd.trim());
      setName('');
      setCwd('');
      await refresh();
      onOpen(wg.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="list-view">
      <header>
        <button type="button" className="btn btn-files" onClick={onBack}>
          ← Back
        </button>
        <h1>Workgroups</h1>
      </header>

      <main>
        <div
          className="create-workgroup"
          style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}
        >
          <input
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Project folder, e.g. C:\\path\\to\\project"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            style={{ flex: 1, minWidth: '14rem' }}
          />
          <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? 'Creating…' : '+ New workgroup'}
          </button>
        </div>

        {error && <p className="empty-hint">{error}</p>}

        {groups.length === 0 ? (
          <p className="empty-hint">
            No workgroups yet. Create one above — pick the project folder its AIs will run in.
          </p>
        ) : (
          <ul className="session-list">
            {groups.map((g) => (
              <li key={g.id}>
                <button type="button" className="session-card" onClick={() => onOpen(g.id)}>
                  <div className="session-card-row">
                    <span className="session-name">{g.name}</span>
                    <span className="session-adapter">{g.memberCount} member(s)</span>
                  </div>
                  <div className="session-card-row session-meta">
                    <span className="session-cwd" title={g.cwd}>
                      {g.cwd}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
