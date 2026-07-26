import { useCallback, useEffect, useRef, useState } from 'react';

export interface ServerFile {
  name: string;
  size: number;
  mtime: number;
}

export interface FileManagerProps {
  onClose: () => void;
}

interface UploadState {
  percent: number;
  loaded: number;
  total: number;
  speedMBps: number;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

export function FileManager({ onClose }: FileManagerProps): JSX.Element {
  const [files, setFiles] = useState<ServerFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, UploadState>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/files');
      if (res.ok) {
        setFiles(await res.json());
      }
    } catch (e) {
      console.error('Failed to fetch files', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    for (const file of Array.from(selectedFiles)) {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      let uploadedBytes = 0;
      const startTime = performance.now();
      let uploadId: string | undefined;

      setUploadProgress((prev) => ({
        ...prev,
        [file.name]: { percent: 0, loaded: 0, total: file.size, speedMBps: 0 },
      }));

      try {
        const createRes = await fetch('/api/uploads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            totalSize: file.size,
            totalChunks,
          }),
        });
        if (!createRes.ok) {
          throw new Error(`HTTP ${createRes.status}: ${await createRes.text()}`);
        }
        uploadId = ((await createRes.json()) as { uploadId: string }).uploadId;

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);

          const formData = new FormData();
          formData.append('file', chunk, file.name);

          const res = await fetch(`/api/uploads/${uploadId}/chunks/${chunkIndex}`, {
            method: 'POST',
            body: formData,
          });

          if (!res.ok) {
            let errorDetail = '';
            try {
              errorDetail = await res.text();
            } catch (_e) {
              /* ignore */
            }
            throw new Error(`HTTP ${res.status}: ${errorDetail}`);
          }

          uploadedBytes += chunk.size;
          const elapsedSec = (performance.now() - startTime) / 1000;
          const speedMBps = elapsedSec > 0 ? uploadedBytes / 1024 / 1024 / elapsedSec : 0;
          setUploadProgress((prev) => ({
            ...prev,
            [file.name]: {
              percent: Math.round((uploadedBytes / file.size) * 100),
              loaded: uploadedBytes,
              total: file.size,
              speedMBps,
            },
          }));
        }

        let completeRes: Response;
        try {
          completeRes = await fetch(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
        } catch {
          // Completion is idempotent server-side; one retry resolves the common
          // case where the server published the file but the response was lost.
          completeRes = await fetch(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
        }
        if (!completeRes.ok) {
          throw new Error(`HTTP ${completeRes.status}: ${await completeRes.text()}`);
        }
        setUploadProgress((prev) => ({
          ...prev,
          [file.name]: {
            percent: 100,
            loaded: file.size,
            total: file.size,
            speedMBps:
              file.size > 0
                ? file.size / 1024 / 1024 / ((performance.now() - startTime) / 1000)
                : 0,
          },
        }));
        uploadId = undefined;
      } catch (err) {
        if (uploadId) {
          await fetch(`/api/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => undefined);
        }
        const e = err as { name?: string; message?: string };
        console.error(`Error uploading ${file.name}:`, err);
        // On mobile, many failures here are actually the browser refusing to
        // read the selected file because it lives under a sandboxed app folder
        // (e.g. WhatsApp / WeChat / Telegram media, or app-private storage).
        // The canonical workaround is to copy the file to the public
        // Downloads / Download / 下载 folder, where the browser is always
        // allowed to read it, and re-select from there.
        const isLikelyPermission =
          e.name === 'NotAllowedError' ||
          e.name === 'NotReadableError' ||
          e.name === 'SecurityError' ||
          // On mobile, when the browser cannot read the picked file from its
          // sandboxed source, the streamed fetch body read fails and surfaces
          // as a generic "TypeError: Failed to fetch" — there's no more
          // specific error available. We treat it as a permission case
          // because that's overwhelmingly the cause on mobile and the
          // remediation (copy to Downloads) is harmless even if the real
          // cause was a network drop.
          /permission|denied|not\s*allowed|not\s*readable|failed\s*to\s*fetch|load\s*failed|network\s*request\s*failed/i.test(
            e.message ?? '',
          );
        const hint = isLikelyPermission
          ? '\n\n📵 手机浏览器无法读取所选文件，通常是因为它在某个 App 的私有目录里（聊天 App 的图片视频、其他 App 的 Documents 等）。\n   解决：先把文件复制到手机的 "下载" / "Download" 文件夹，再从那里选。\n\n📵 Your phone browser cannot read the file from its current folder (common for files inside chat apps or app-private storage).\n   Tip: copy the file to your Downloads / Download folder and pick it from there.'
          : '';
        alert(`Failed to upload ${file.name}\nReason: ${e.message ?? String(err)}${hint}`);
      }

      // Refresh listing immediately so this file shows up in the table while
      // we leave the progress row visible at 100% for a moment.
      fetchFiles();

      setTimeout(() => {
        setUploadProgress((prev) => {
          const next = { ...prev };
          delete next[file.name];
          return next;
        });
      }, 1500);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDownload = (filename: string) => {
    window.open(`/api/download/${encodeURIComponent(filename)}`, '_blank');
  };

  const handleDelete = async (filename: string) => {
    // eslint-disable-next-line no-alert -- confirm() is the simplest UX here; modal dialog would be overkill.
    if (!window.confirm(`Delete "${filename}"? / 确认删除 "${filename}" 吗？`)) return;
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = await res.text();
        } catch (_e) {
          /* ignore */
        }
        throw new Error(`HTTP ${res.status}: ${detail}`);
      }
      // Optimistically remove from local state, then refresh.
      setFiles((prev) => prev.filter((f) => f.name !== filename));
      fetchFiles();
    } catch (err) {
      const e = err as { message?: string };
      alert(`Failed to delete ${filename}\nReason: ${e.message ?? String(err)}`);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay click is convenience; Esc/× button cover keyboard.
    <div className="modal-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only; inner content is keyboard-operable. */}
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📁 File Manager (Local Network)</h2>
          <button type="button" className="btn-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="upload-section">
            <input
              type="file"
              multiple
              accept="*/*"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={handleUpload}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
            >
              📤 Upload File
            </button>
            <span className="upload-hint">
              {' '}
              Streams large files in 5 MB chunks. If upload fails on mobile, copy the file to your
              Downloads / 下载 folder and retry.
            </span>
          </div>

          {Object.keys(uploadProgress).length > 0 && (
            <div className="uploads-panel">
              <div className="uploads-panel-title">Uploading…</div>
              {Object.entries(uploadProgress).map(([name, st]) => (
                <div key={name} className="upload-row">
                  <div className="upload-row-head">
                    <span className="upload-row-name">{name}</span>
                    <span className="upload-row-stats">
                      {formatSize(st.loaded)} / {formatSize(st.total)} · {st.speedMBps.toFixed(1)}{' '}
                      MB/s · {st.percent}%
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${st.percent}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="files-list">
            {loading ? (
              <p>Loading files...</p>
            ) : files.length === 0 ? (
              <p className="empty-hint">No files on server yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Size</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.name}>
                      <td className="filename-cell">{f.name}</td>
                      <td>{formatSize(f.size)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() => handleDownload(f.name)}
                          >
                            📥 Download
                          </button>
                          <button
                            type="button"
                            className="btn btn-small btn-danger"
                            onClick={() => handleDelete(f.name)}
                            title="Delete file"
                          >
                            🗑️ Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
