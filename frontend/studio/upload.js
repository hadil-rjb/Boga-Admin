/* Resumable upload of a footage clip: POST a session, PUT the chunks the server does not have yet (3 in parallel), complete. */
const MAX = 2 * 1024 * 1024 * 1024;
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const extOf = (n) => (/\.([a-z0-9]+)$/i.exec(n || '') || [])[1]?.toLowerCase() || '';

export const isVideoFile = (f) => !!f && (/^video\//.test(f.type) || (!f.type && !!MIME[extOf(f.name)]));

/**
 * @param {File} file
 * @param {{ role: 'original' | 'reference', brand?: string, api: Function, onProgress?: (v: number) => void, signal?: AbortSignal, sleep?: (ms: number) => Promise<void> }} o
 * Retries network errors, 5xx and 429 only. A 409 on a chunk means the record left 'uploading': when it is past that, go straight to complete.
 * @returns {Promise<{ id: string }>}
 */
export const isAbort = (e) => !!e && e.name === 'AbortError';
const stopped = () => new DOMException('Upload stopped', 'AbortError');

export async function uploadFootage(file, { role, brand, api, onProgress, signal, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!isVideoFile(file)) throw new Error('Choose a video file');
  if (file.size > MAX) throw new Error('This video is larger than 2 GB');
  if (!file.size) throw new Error('This video file is empty');
  const mime = file.type || MIME[extOf(file.name)] || 'video/mp4';
  const rec = await api('/footage', { method: 'POST', body: { name: file.name, size: file.size, mime, role, brand } });
  const { id, chunkSize } = rec, n = Math.ceil(file.size / chunkSize), have = new Set(rec.received || []);
  const len = (i) => Math.min(chunkSize, file.size - i * chunkSize);
  let sent = 0; for (const i of have) if (i >= 0 && i < n) sent += len(i);
  const report = () => onProgress && onProgress(Math.min(1, sent / file.size));
  report();
  const todo = []; for (let i = 0; i < n; i++) if (!have.has(i)) todo.push(i);
  let next = 0, failed = null, finished = false;
  const check = () => { if (signal && signal.aborted) throw stopped(); };
  const worker = async () => {
    while (!failed && !finished && next < todo.length) {
      const i = todo[next++];
      try {
        for (let tries = 1; ; tries++) {
          check();
          try {
            await api(`/footage/${id}/chunk?i=${i}`, { method: 'PUT', raw: true, body: file.slice(i * chunkSize, i * chunkSize + len(i)), signal });
            break;
          } catch (e) {
            if (isAbort(e) || (signal && signal.aborted)) throw stopped();
            const st = e && e.status;
            if (st === 409) {
              const cur = await api(`/footage/${id}`, { signal });
              if (cur && cur.status && cur.status !== 'uploading') { finished = true; return; }
              throw e;
            }
            const transient = !st || st >= 500 || st === 429;
            if (!transient || tries >= 3) throw e;
            await sleep(400 * tries);
          }
        }
      } catch (e) { failed = failed || e; return; }
      sent += len(i); report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
  if (failed) throw failed;
  check();
  const done = await api(`/footage/${id}/complete`, { method: 'POST', signal });
  if (onProgress) onProgress(1);
  return { ...(done || {}), id };
}
