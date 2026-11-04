/* Resumable upload of a footage clip: POST a session, PUT the chunks the server does not have yet (3 in parallel), complete. */
const MAX = 2 * 1024 * 1024 * 1024;
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const extOf = (n) => (/\.([a-z0-9]+)$/i.exec(n || '') || [])[1]?.toLowerCase() || '';

export const isVideoFile = (f) => !!f && (/^video\//.test(f.type) || (!f.type && !!MIME[extOf(f.name)]));

/**
 * @param {File} file
 * @param {{ role: 'original' | 'reference', brand?: string, api: Function, onProgress?: (v: number) => void }} o
 * @returns {Promise<{ id: string }>}
 */
export async function uploadFootage(file, { role, brand, api, onProgress }) {
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
  let next = 0, failed = null;
  const worker = async () => {
    while (!failed && next < todo.length) {
      const i = todo[next++];
      for (let tries = 1; ; tries++) {
        try {
          await api(`/footage/${id}/chunk?i=${i}`, { method: 'PUT', raw: true, body: file.slice(i * chunkSize, i * chunkSize + len(i)) });
          break;
        } catch (e) {
          if (tries >= 3 || /not uploading/i.test(e && e.message)) { failed = failed || e; return; }
          await new Promise((r) => setTimeout(r, 400 * tries));
        }
      }
      sent += len(i); report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
  if (failed) throw failed;
  const done = await api(`/footage/${id}/complete`, { method: 'POST' });
  if (onProgress) onProgress(1);
  return { ...(done || {}), id };
}
