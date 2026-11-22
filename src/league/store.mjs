// League stores. Same interface in every runtime (memory, fs, Azure Blob, D1):
//   list()                  -> Promise<entry[]>       every standing (active and dormant)
//   get(host)               -> Promise<entry|null>
//   submit(host, fn)        -> Promise<result>        atomic read-modify-write: fn(prevEntry|null) returns
//                                                     { entry, changed, ... }; the entry is stored when changed
//   remove(host, {suppress}) -> Promise<boolean>      moderation: deletes the standing and (default) tombstones the host
//   restore(host)           -> Promise<boolean>       lifts a tombstone
//   isSuppressed(host)      -> Promise<boolean>
// Runtime-neutral: this file has no node: imports. The fs, Azure and D1 stores build on docLeague or follow its contract.
import { normalizeHost, DAY } from './engine.mjs';

export const MAX_ENTRIES = 2000; // with the compact ranking history a worst-case board.json stays near 10 MiB
export const FORGET_MS = 180 * DAY; // standings untouched for this long are deleted on the next write

/** Drop long-dormant standings and, past the cap, the lowest-XP ones. Mutates and returns the entries map. */
export function prune(entries, now = Date.now()) {
  for (const [h, e] of Object.entries(entries)) if (now - Date.parse(e.updated_at) > FORGET_MS) delete entries[h];
  const hosts = Object.keys(entries);
  if (hosts.length > MAX_ENTRIES) {
    hosts.sort((a, b) => entries[a].xp - entries[b].xp);
    for (const h of hosts.slice(0, hosts.length - MAX_ENTRIES)) delete entries[h];
  }
  return entries;
}

/**
 * A league store over one JSON document with optimistic concurrency.
 * @param {{ load: () => Promise<{doc: object|null, tag?: any}>, save: (doc: object, tag: any) => Promise<boolean>, now?: () => number }} io
 *   save returns false when the document changed since load (the write is retried).
 */
export function docLeague({ load, save, now = () => Date.now() }) {
  const read = async () => { const r = await load(); return { entries: r.doc?.entries || {}, suppressed: r.doc?.suppressed || {}, tag: r.tag }; };
  const doc = (entries, suppressed) => ({ v: 1, entries, suppressed });
  // Writes from this process run one at a time, so they never fight each other; the version tag (ETag, version
  // column) only has to settle conflicts with other instances, which a short random back-off keeps rare.
  let queue = Promise.resolve();
  const serial = (fn) => (...a) => { const run = queue.then(() => fn(...a)); queue = run.catch(() => {}); return run; };
  const pause = (attempt) => (attempt ? new Promise((r) => setTimeout(r, Math.random() * 40 * attempt)) : null);
  return {
    kind: 'doc',
    async list() { return Object.values((await read()).entries); },
    async get(host) { return (await read()).entries[normalizeHost(host)] || null; },
    submit: serial(async (host, fn) => {
      const h = normalizeHost(host);
      for (let attempt = 0; attempt < 8; attempt++) {
        await pause(attempt);
        const { entries, suppressed, tag } = await read();
        if (suppressed[h]) return { entry: null, changed: false, events: [], error: 'suppressed', message: 'This site was removed from the League and cannot be added again by a submission.' };
        const retained = prune({ ...entries }, now());
        const out = await fn(retained[h] || null);
        if (!out.changed) return out;
        const next = prune({ ...retained, [h]: out.entry }, now());
        if (!Object.hasOwn(next, h)) return { entry: null, changed: false, events: [], error: 'capacity', message: 'The League is full and cannot retain this standing. Try again later.' };
        if (await save(doc(next, suppressed), tag)) return out;
      }
      throw new Error('The League is busy, try again in a moment.');
    }),
    // Moderation. remove() deletes the standing and, unless told otherwise, leaves a tombstone so a submission cannot add the
    // host straight back. restore() lifts the tombstone on purpose. Both are for the admin route only.
    remove: serial(async (host, { suppress = true } = {}) => {
      const h = normalizeHost(host);
      for (let attempt = 0; attempt < 8; attempt++) {
        await pause(attempt);
        const { entries, suppressed, tag } = await read();
        const had = !!entries[h]; const already = !!suppressed[h];
        if (!had && (already || !suppress)) return false;
        const { [h]: _gone, ...rest } = entries;
        const sup = suppress ? { ...suppressed, [h]: { at: new Date(now()).toISOString() } } : suppressed;
        if (await save(doc(rest, sup), tag)) return true;
      }
      throw new Error('The League is busy, try again in a moment.');
    }),
    restore: serial(async (host) => {
      const h = normalizeHost(host);
      for (let attempt = 0; attempt < 8; attempt++) {
        await pause(attempt);
        const { entries, suppressed, tag } = await read();
        if (!suppressed[h]) return false;
        const { [h]: _lifted, ...rest } = suppressed;
        if (await save(doc(entries, rest), tag)) return true;
      }
      throw new Error('The League is busy, try again in a moment.');
    }),
    async isSuppressed(host) { return !!(await read()).suppressed[normalizeHost(host)]; },
  };
}

/** In-memory league (tests, the CLI, single-process servers). */
export function memoryLeague({ now = () => Date.now() } = {}) {
  let doc = null; let version = 0;
  const api = docLeague({
    now,
    load: async () => ({ doc: doc ? structuredClone(doc) : null, tag: version }),
    save: async (next, tag) => { if (tag !== version) return false; doc = structuredClone(next); version += 1; return true; },
  });
  return { ...api, kind: 'memory' };
}
