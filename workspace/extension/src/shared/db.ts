// IndexedDB store (§13): all learning data, frames and transcripts, local to this browser profile.
// Usable from the service worker and every extension page (same origin). Content scripts and the
// sandbox cannot reach it. Read-modify-write of one record happens inside one transaction.
import { EMPTY_LEARNER } from './learner';
import type {
  Bookmark,
  HistoryEntry,
  Mistake,
  PlaylistInfo,
  PracticeProblem,
  ReviewCard,
  StoredFrame,
  Transcript,
  VideoRecord,
} from './types';

export const DB_NAME = 'youtube-tutor';
export const DB_VERSION = 1;

export interface StoreTypes {
  videos: VideoRecord;
  history: HistoryEntry;
  transcripts: Transcript;
  frames: StoredFrame;
  bookmarks: Bookmark;
  mistakes: Mistake;
  cards: ReviewCard;
  problems: PracticeProblem;
  playlists: PlaylistInfo;
  kv: { key: string; value: unknown };
}
export type StoreName = keyof StoreTypes;

/** Stores holding per-video collections, indexed by videoId. */
export const BY_VIDEO: StoreName[] = ['history', 'frames', 'bookmarks', 'mistakes', 'cards', 'problems'];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const make = (name: StoreName, keyPath: string, indexes: [string, string][] = []) => {
        if (db.objectStoreNames.contains(name)) return;
        const s = db.createObjectStore(name, { keyPath });
        for (const [iname, path] of indexes) s.createIndex(iname, path);
      };
      make('videos', 'videoId', [['updatedAt', 'updatedAt']]);
      make('history', 'id', [['videoId', 'videoId']]);
      make('transcripts', 'videoId');
      make('frames', 'id', [['videoId', 'videoId']]);
      make('bookmarks', 'id', [['videoId', 'videoId']]);
      make('mistakes', 'id', [['videoId', 'videoId']]);
      make('cards', 'id', [['videoId', 'videoId'], ['due', 'due']]);
      make('problems', 'id', [['videoId', 'videoId']]);
      make('playlists', 'id');
      make('kv', 'key');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function get<S extends StoreName>(store: S, key: IDBValidKey): Promise<StoreTypes[S] | undefined> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<StoreTypes[S] | undefined>;
}

export async function getAll<S extends StoreName>(store: S): Promise<StoreTypes[S][]> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).getAll()) as Promise<StoreTypes[S][]>;
}

export async function byVideo<S extends StoreName>(store: S, videoId: string): Promise<StoreTypes[S][]> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).index('videoId').getAll(videoId)) as Promise<StoreTypes[S][]>;
}

export async function put<S extends StoreName>(store: S, value: StoreTypes[S]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
}

export async function putMany<S extends StoreName>(store: S, values: StoreTypes[S][]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  for (const v of values) s.put(v);
  await txDone(tx);
}

export async function del(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

/** Atomic read-modify-write of one record. `fn` gets the current value (or undefined). */
export async function update<S extends StoreName>(store: S, key: IDBValidKey, fn: (cur: StoreTypes[S] | undefined) => StoreTypes[S] | undefined): Promise<StoreTypes[S] | undefined> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  const cur = (await done(s.get(key))) as StoreTypes[S] | undefined;
  const next = fn(cur);
  if (next !== undefined && next !== cur) s.put(next);
  await txDone(tx);
  return next ?? cur;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await get('kv', key))?.value as T | undefined;
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  await put('kv', { key, value });
}

// ---- video records ----

export function emptyVideo(videoId: string, now = Date.now()): VideoRecord {
  return {
    videoId,
    title: '',
    channel: '',
    lengthSeconds: 0,
    chapters: [],
    playlist: null,
    createdAt: now,
    updatedAt: now,
    lastT: 0,
    timeSpentSec: 0,
    map: null,
    learner: EMPTY_LEARNER,
    known: [],
    quiz: [],
    checkpointResults: [],
    teachBacks: [],
    preQuestions: [],
    prereqChecks: [],
    feynman: null,
    cheatSheet: null,
    glossaryExtra: [],
  };
}

/** Fills fields missing from records written by older code. */
export function completeVideo(v: Partial<VideoRecord> & { videoId: string }): VideoRecord {
  return { ...emptyVideo(v.videoId, v.createdAt), ...v } as VideoRecord;
}

export async function getVideo(videoId: string): Promise<VideoRecord | null> {
  const v = await get('videos', videoId);
  return v ? completeVideo(v) : null;
}

export async function updateVideo(videoId: string, fn: (v: VideoRecord) => VideoRecord | Partial<VideoRecord>): Promise<VideoRecord> {
  const res = await update('videos', videoId, (cur) => {
    const base = cur ? completeVideo(cur) : emptyVideo(videoId);
    const patch = fn(base);
    return { ...base, ...patch, updatedAt: Date.now() };
  });
  return res as VideoRecord;
}

/** Deletes everything stored for one video. */
export async function clearVideoData(videoId: string): Promise<void> {
  const db = await openDb();
  const stores: StoreName[] = ['videos', 'transcripts', ...BY_VIDEO];
  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore('videos').delete(videoId);
  tx.objectStore('transcripts').delete(videoId);
  for (const name of BY_VIDEO) {
    const idx = tx.objectStore(name).index('videoId');
    const req = idx.openKeyCursor(IDBKeyRange.only(videoId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        tx.objectStore(name).delete(cur.primaryKey);
        cur.continue();
      }
    };
  }
  await txDone(tx);
}

/** Deletes all learning data (keeps kv flags such as the migration marker). */
export async function clearAllData(): Promise<void> {
  const db = await openDb();
  const stores: StoreName[] = ['videos', 'transcripts', 'playlists', ...BY_VIDEO];
  const tx = db.transaction(stores, 'readwrite');
  for (const s of stores) tx.objectStore(s).clear();
  await txDone(tx);
}

/** Cards due at `now`, via the "due" index. */
export async function dueCardsFromDb(now = Date.now()): Promise<ReviewCard[]> {
  const db = await openDb();
  return done(db.transaction('cards').objectStore('cards').index('due').getAll(IDBKeyRange.upperBound(now))) as Promise<ReviewCard[]>;
}

/** Primary keys of a per-video store (no values loaded). */
export async function keysByVideo(store: StoreName, videoId: string): Promise<string[]> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).index('videoId').getAllKeys(videoId)) as Promise<string[]>;
}

export async function delMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (!keys.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  for (const k of keys) tx.objectStore(store).delete(k);
  await txDone(tx);
}
