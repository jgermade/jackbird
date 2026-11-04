// The saved session (the open roots' handles and the active root) in
// IndexedDB, which can hold directory handles where localStorage cannot.
// lib/session.ts decides when to read and write it.

import type { Session } from "../helpers/session";

type PersistedSession = Session<FileSystemDirectoryHandle>;

const DB_NAME = "mp3-manager";
const STORE_NAME = "session";
const SESSION_KEY = "roots-session";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
  });
}

export async function loadRootSession(): Promise<PersistedSession> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(SESSION_KEY);

    request.onsuccess = () => {
      const result = request.result as PersistedSession | undefined;
      resolve(
        result ?? {
          roots: [],
          activeRootId: null
        }
      );
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read the session."));
  });
}

export async function saveRootSession(session: PersistedSession): Promise<void> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save the session."));

    const store = tx.objectStore(STORE_NAME);
    store.put(session, SESSION_KEY);
  });
}
