import { useCallback, useEffect, useState } from 'react';
import { useCameraPush } from './use-camera-push.js';

export interface CameraViewerProps {
  serverBase: string;
  onBack: () => void;
}

interface CameraSource {
  name: string;
}

function nextCameraName(existing: CameraSource[]): string {
  const names = new Set(existing.map((s) => s.name));
  for (let i = 1; ; i++) {
    const candidate = `camera${i}`;
    if (!names.has(candidate)) return candidate;
  }
}

export function CameraViewer({ serverBase, onBack }: CameraViewerProps): JSX.Element {
  const [sources, setSources] = useState<CameraSource[]>([]);
  const [phoneLive, setPhoneLive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [addUrl, setAddUrl] = useState('');
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const cam = useCameraPush(serverBase);

  const fetchSources = useCallback(async () => {
    try {
      const resp = await fetch(`${serverBase}/api/camera/sources`);
      const data = (await resp.json()) as { sources: Record<string, unknown> };
      // User-added cameras only (exclude phone_cam)
      const userCams = Object.keys(data.sources)
        .filter((n) => n !== 'phone_cam')
        .map((name) => ({ name }));
      setSources(userCams);
    } catch {
      setSources([]);
    }
  }, [serverBase]);

  // Poll go2rtc to detect if phone_cam has active producers (someone is pushing)
  const checkPhoneStatus = useCallback(async () => {
    try {
      const resp = await fetch(`${serverBase}/api/camera/streams`);
      const streams = (await resp.json()) as Record<string, { producers?: unknown[] | string }>;
      const pc = streams.phone_cam;
      if (!pc) { setPhoneLive(false); return; }
      const producers = pc.producers;
      const hasProducer = Array.isArray(producers) ? producers.length > 0 : (typeof producers === 'string' && producers.length > 0);
      setPhoneLive(hasProducer);
    } catch {
      setPhoneLive(false);
    }
  }, [serverBase]);

  useEffect(() => { fetchSources(); }, [fetchSources]);

  useEffect(() => {
    checkPhoneStatus();
    const interval = setInterval(checkPhoneStatus, 3000);
    return () => clearInterval(interval);
  }, [checkPhoneStatus]);

  // Don't stop camera on unmount — CameraViewer stays mounted (hidden) so stream persists

  const handleAdd = async () => {
    const name = addName.trim() || nextCameraName(sources);
    const src = addUrl.trim();
    if (!src) return;
    setAddError(null);
    if (sources.some((s) => s.name === name)) {
      setAddError(`"${name}" already exists / 名称已存在`);
      return;
    }
    try {
      const resp = await fetch(`${serverBase}/api/camera/sources?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, {
        method: 'PUT',
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` })) as { error?: string };
        setAddError(body.error ?? `Failed (${resp.status})`);
        return;
      }
      setAddUrl('');
      setAddName('');
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Network error');
    }
    await fetchSources();
  };

  const handleRemove = async (name: string) => {
    await fetch(`${serverBase}/api/camera/sources?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (selected === name) setSelected(null);
    await fetchSources();
  };

  const streamUrl = selected ? `/go2rtc/stream.html?src=${encodeURIComponent(selected)}` : null;

  const containerStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', height: '100%',
    background: '#0c0c0c', color: '#d4d4d4', fontFamily: 'system-ui, sans-serif',
  };
  const headerStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '8px 12px', borderBottom: '1px solid #333',
  };
  const btnStyle: React.CSSProperties = {
    padding: '6px 12px', border: 'none', borderRadius: '4px',
    cursor: 'pointer', fontSize: '13px', color: '#fff', background: '#333',
  };

  return (
    <div style={containerStyle}>
      <header style={headerStyle}>
        <button type="button" style={btnStyle} onClick={onBack}>Back</button>
        <h1 style={{ fontSize: '16px', margin: 0, flex: 1 }}>Cameras</h1>
      </header>

      {selected ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ flex: 1, fontSize: '14px' }}>{selected}</span>
            <button type="button" style={btnStyle} onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <iframe
            src={streamUrl!}
            style={{ flex: 1, border: 'none', background: '#000', width: '100%' }}
            allow="autoplay; fullscreen"
            allowFullScreen
            title={`Camera: ${selected}`}
          />
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
          {/* Phone Camera Push */}
          <div style={{ marginBottom: '16px' }}>
            <h2 style={{ fontSize: '14px', margin: '0 0 8px' }}>Phone Camera (as webcam)</h2>
            {!cam.isStreaming ? (
              <button type="button" style={{ ...btnStyle, background: '#2563eb' }} onClick={() => cam.start()}>
                Start Camera
              </button>
            ) : (
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ color: '#4ade80', fontSize: '13px', marginRight: '8px' }}>Streaming</span>
                <button type="button" style={btnStyle} onClick={() => cam.switchCamera()}>Flip</button>
                <button type="button" style={{ ...btnStyle, background: cam.isMuted ? '#dc2626' : '#333' }} onClick={() => cam.toggleMute()}>
                  {cam.isMuted ? 'Unmute' : 'Mute'}
                </button>
                <button type="button" style={{ ...btnStyle, background: '#dc2626' }} onClick={() => cam.stop()}>Stop</button>
              </div>
            )}
            {cam.error && <div style={{ color: '#f87171', fontSize: '12px', marginTop: '4px' }}>{cam.error}</div>}
          </div>

          {/* Add Camera */}
          <div style={{ marginBottom: '16px' }}>
            <h2 style={{ fontSize: '14px', margin: '0 0 8px' }}>Add Camera</h2>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder={`Name / auto: ${nextCameraName(sources)}`}
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                style={{ padding: '6px 8px', background: '#1a1a1a', border: '1px solid #444', borderRadius: '4px', color: '#fff', width: '120px' }}
              />
              <input
                type="text"
                placeholder="rtsp://admin:pass@192.168.1.100:554/Streaming/Channels/1"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                style={{ padding: '6px 8px', background: '#1a1a1a', border: '1px solid #444', borderRadius: '4px', color: '#fff', flex: 1, minWidth: '200px' }}
              />
              <button type="button" style={{ ...btnStyle, background: '#2563eb' }} onClick={handleAdd}>
                Add
              </button>
            </div>
            {addError && <div style={{ color: '#f87171', fontSize: '12px', marginTop: '4px' }}>{addError}</div>}
            <details style={{ marginTop: '8px', fontSize: '12px', color: '#888' }}>
              <summary style={{ cursor: 'pointer' }}>URL examples / URL 格式参考</summary>
              <pre style={{ margin: '6px 0', padding: '8px', background: '#111', borderRadius: '4px', overflowX: 'auto', fontSize: '11px', lineHeight: '1.5' }}>
{`Hikvision / 海康:
  rtsp://admin:pass@192.168.1.100:554/Streaming/Channels/1
Dahua / 大华:
  rtsp://admin:pass@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0
Generic ONVIF / 通用:
  rtsp://admin:pass@192.168.1.100:554/stream1
HTTP / HLS:
  http://192.168.1.100:8080/video
RTMP:
  rtmp://192.168.1.100/live/stream`}
              </pre>
            </details>
          </div>

          {/* Camera Sources */}
          <h2 style={{ fontSize: '14px', margin: '0 0 8px' }}>Camera Sources</h2>

          {/* Phone cam - auto appears when live */}
          {phoneLive && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '8px 12px', background: '#1a1a1a', borderRadius: '6px', marginBottom: '6px',
            }}>
              <span style={{ flex: 1, fontSize: '14px' }}>
                phone_cam <span style={{ color: '#4ade80', fontSize: '12px', marginLeft: '6px' }}>LIVE</span>
              </span>
              <button type="button" style={{ ...btnStyle, background: '#2563eb' }} onClick={() => setSelected('phone_cam')}>
                View
              </button>
            </div>
          )}

          {sources.length === 0 && !phoneLive ? (
            <p style={{ color: '#888', fontSize: '13px' }}>No cameras configured.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {sources.map((s) => (
                <div
                  key={s.name}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '8px 12px', background: '#1a1a1a', borderRadius: '6px',
                  }}
                >
                  <span style={{ flex: 1, fontSize: '14px' }}>{s.name}</span>
                  <button type="button" style={{ ...btnStyle, background: '#2563eb' }} onClick={() => setSelected(s.name)}>
                    View
                  </button>
                  <button type="button" style={{ ...btnStyle, background: '#dc2626' }} onClick={() => handleRemove(s.name)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
