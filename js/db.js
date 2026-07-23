/**
 * db.js — Minimal IndexedDB wrapper used to persist scanned documents
 * on-device so the scan history survives reloads and works offline.
 * Each stored record: { id, name, createdAt, pages: [dataURL, ...] }
 */
const DocuDB = (() => {
  const DB_NAME = "skanix-db";
  const STORE = "documents";
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode) {
    const db = await open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  return {
    async saveDocument(doc) {
      const store = await tx("readwrite");
      return new Promise((resolve, reject) => {
        const req = store.put(doc);
        req.onsuccess = () => resolve(doc);
        req.onerror = () => reject(req.error);
      });
    },
    async getAll() {
      const store = await tx("readonly");
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
        req.onerror = () => reject(req.error);
      });
    },
    async getById(id) {
      const store = await tx("readonly");
      return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async remove(id) {
      const store = await tx("readwrite");
      return new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },
    async clear() {
      const store = await tx("readwrite");
      return new Promise((resolve, reject) => {
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },
  };
})();
