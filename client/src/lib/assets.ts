// Files the user picked for this device only (their own ringtone, a chat
// wallpaper): kept in IndexedDB — too big for localStorage, not worth a server
// round trip.
const DB = "nova-assets";
const STORE = "files";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export type AssetKey = "ringtone" | "wallpaper";

export const putAsset = (key: AssetKey, file: Blob) => tx("readwrite", (s) => s.put(file, key)).then(() => notify(key));
export const getAsset = (key: AssetKey) => tx<Blob | undefined>("readonly", (s) => s.get(key)).catch(() => undefined);
export const deleteAsset = (key: AssetKey) => tx("readwrite", (s) => s.delete(key)).then(() => notify(key));

// Whoever shows an asset re-reads it when it changes.
const listeners = new Set<(key: AssetKey) => void>();
const notify = (key: AssetKey) => listeners.forEach((l) => l(key));
export function onAssetChange(fn: (key: AssetKey) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
