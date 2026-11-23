// Project files by content hash, in the Overleaf origin's IndexedDB, so reopening a project
// doesn't download its images again.
const DB = 'olr-blob-cache'
const STORE = 'blobs'

let db: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return db
}

export async function getBlob(hash: string): Promise<Uint8Array | null> {
  const d = await open()
  return new Promise(resolve => {
    const req = d.transaction(STORE).objectStore(STORE).get(hash)
    req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null)
    req.onerror = () => resolve(null)
  })
}

export async function putBlob(hash: string, bytes: Uint8Array): Promise<void> {
  const d = await open()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(bytes.slice().buffer, hash)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
