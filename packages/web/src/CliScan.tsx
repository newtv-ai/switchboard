import { useCallback, useEffect, useState } from 'react';
import { type CliScanResult, scanClis } from './workgroups-api.js';

export interface CliScanProps {
  onClose: () => void;
}

/** Modal that lists the AI coding CLIs detected on the dev box (GET /api/scan). */
export function CliScan({ onClose }: CliScanProps): JSX.Element {
  const [results, setResults] = useState<CliScanResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setResults(await scanClis());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'scan failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    scan();
  }, [scan]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay click closes the modal; inner content is keyboard-operable.
    <div className="modal-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only; inner content is keyboard-operable. */}
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🔍 AI CLIs on this machine</h2>
          <button type="button" className="btn-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="row-actions" style={{ marginBottom: '0.75rem' }}>
            <button type="button" className="btn btn-primary" onClick={scan} disabled={loading}>
              {loading ? 'Scanning…' : 'Rescan'}
            </button>
          </div>

          {error && <p className="empty-hint">Scan failed: {error}</p>}

          {!error && !loading && results.length === 0 && (
            <p className="empty-hint">No AI CLIs detected on PATH.</p>
          )}

          {results.length > 0 && (
            <ul className="session-list">
              {results.map((r) => (
                <li key={r.adapterId}>
                  <div className="session-card">
                    <div className="session-card-row">
                      <span className="session-name">{r.displayName}</span>
                      <span className={`session-state state-${r.status}`}>{r.status}</span>
                    </div>
                    <div className="session-card-row session-meta">
                      {r.version && <span className="session-adapter">v{r.version}</span>}
                      <span className="session-source">
                        {r.hasAdapter ? 'adapter' : 'raw (passthrough)'}
                      </span>
                    </div>
                    {r.path && (
                      <div className="session-card-row session-meta">
                        <span className="session-cwd" title={r.path}>
                          {r.path}
                        </span>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
