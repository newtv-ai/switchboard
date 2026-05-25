import { useCallback, useEffect, useRef, useState } from 'react';

export interface ServerFile {
  name: string;
  size: number;
  mtime: number;
}

export interface FileManagerProps {
  onClose: () => void;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

export function FileManager({ onClose }: FileManagerProps): JSX.Element {
  const [files, setFiles] = useState<ServerFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
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

      // Reset progress
      setUploadProgress((prev) => ({ ...prev, [file.name]: 0 }));

      try {
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);

          const formData = new FormData();
          formData.append('file', chunk, file.name);

          const isAppend = chunkIndex > 0;

          const res = await fetch('/api/upload', {
            method: 'POST',
            headers: {
              'x-upload-append': isAppend ? 'true' : 'false',
            },
            body: formData,
          });

          if (!res.ok) {
            let errorDetail = '';
            try {
              errorDetail = await res.text();
            } catch (e) {}
            throw new Error(`HTTP ${res.status}: ${errorDetail}`);
          }

          uploadedBytes += chunk.size;
          setUploadProgress((prev) => ({
            ...prev,
            [file.name]: Math.round((uploadedBytes / file.size) * 100),
          }));
        }
      } catch (err) {
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
          /permission|denied|not\s*allowed|not\s*readable/i.test(e.message ?? '');
        const hint = isLikelyPermission
          ? "\n\nThis usually means your phone browser cannot read the file from its current folder (common for files inside chat apps or app-private storage).\nTip: copy the file to your phone's Downloads / Download / 下载 folder, then pick it from there."
          : '';
        alert(`Failed to upload ${file.name}\nReason: ${e.message ?? String(err)}${hint}`);
      }

      // Clear progress after short delay
      setTimeout(() => {
        setUploadProgress((prev) => {
          const next = { ...prev };
          delete next[file.name];
          return next;
        });
      }, 2000);
    }

    // Refresh list
    fetchFiles();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDownload = (filename: string) => {
    window.open(`/api/download/${encodeURIComponent(filename)}`, '_blank');
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
                      <td className="filename-cell">
                        {f.name}
                        {uploadProgress[f.name] !== undefined && (
                          <div className="progress-bar">
                            <div
                              className="progress-fill"
                              style={{ width: `${uploadProgress[f.name]}%` }}
                            />
                            <span className="progress-text">{uploadProgress[f.name]}%</span>
                          </div>
                        )}
                      </td>
                      <td>{formatSize(f.size)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => handleDownload(f.name)}
                        >
                          📥 Download
                        </button>
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
