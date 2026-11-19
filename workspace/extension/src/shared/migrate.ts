// One-time migration of first-build data (chrome.storage) into IndexedDB. Safe to call from any
// extension context; a Web Lock makes concurrent callers wait for one migration.
import * as db from './db';
import { mergeMigrated, migrateV1 } from './library';
import { cardsForVideo } from './srs';

const FLAG = 'migratedV1';

export async function ensureMigrated(): Promise<{ migrated: number } | null> {
  if (await db.kvGet<boolean>(FLAG)) return null;
  return navigator.locks.request('yt-tutor-migrate', async () => {
    if (await db.kvGet<boolean>(FLAG)) return null;
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null).catch(() => ({}));
    const r = migrateV1(local, session);
    for (const v of r.videos) {
      // Look the record up first: updateVideo hands its callback a blank default when nothing is
      // stored, and that default must not be mistaken for newer saved data.
      const existing = await db.getVideo(v.videoId);
      await db.updateVideo(v.videoId, () => mergeMigrated(existing, v));
    }
    await db.putMany('history', r.history);
    await db.putMany('transcripts', r.transcripts);
    for (const v of r.videos) {
      const existing = new Set((await db.byVideo('cards', v.videoId)).map((c) => c.id));
      await db.putMany('cards', cardsForVideo(v).filter((c) => !existing.has(c.id)));
    }
    await db.kvSet(FLAG, true);
    if (r.migratedKeys.length) await chrome.storage.local.remove(r.migratedKeys);
    return { migrated: r.videos.length };
  });
}
