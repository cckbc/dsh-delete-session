/**
 * Host half of the "delete session" bundle.
 *
 * The Harness has no deletion seam for session logs: the JSONL persistence
 * backend documents "Nothing deletes session files — logs accumulate under
 * `root` until removed externally; the seam has no deletion API", and the
 * Workspace registry only hides sessions (archive) without touching history.
 *
 * So this plugin owns a recycle bin:
 *
 * - `POST …/session` with `action: 'delete'` MOVES the session's log directory
 *   into `<DSH_HOME>/dsh-trash/<stamp>-<id>/log/` instead of destroying it, and
 *   records what it was (title, working directory, size, deletion time, expiry)
 *   in `<DSH_HOME>/dsh-trash/index.json`;
 * - `action: 'list'` reports the bin, purging entries whose retention expired;
 * - `action: 'restore'` moves a log directory back to the workspace it came
 *   from and re-accounts the session in the workspace registry state;
 * - `action: 'purge'` and `action: 'empty'` delete permanently, on request.
 *
 * A log is moved FILE BY FILE, never by renaming its directory, and its
 * projection cache travels with it. Both are forced by what the running app
 * does to the files this plugin moves: it keeps the sessions it has open in
 * memory, holding their logs open — and Windows refuses to rename a directory
 * that holds an open file, while it happily renames the open file itself — and
 * it owns the cache that carries a session's NAME, rebuilding it only when it
 * reads a session, which never happens to a session whose log just left. Moving
 * the directory made "delete" fail with "the session log is in use" for as long
 * as a session stayed open, restart included; deleting the cache lost the name
 * for good. (Both were measured on Windows: renaming a directory that holds an
 * open file fails with EPERM, while renaming or deleting the open file itself
 * succeeds.)
 *
 * A timer purges expired entries while the app runs, so the bin cannot grow
 * forever. Nothing outside `<DSH_HOME>/dsh-trash` and the session-derived
 * locations below is ever written:
 *
 * 1. `<DSH_HOME>/sessions/<workspace>/<id>/` (moved, not copied);
 * 2. `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` (derived cache);
 * 3. `<DSH_HOME>/storages/workspace.json` (accounting sets).
 *
 * Every path is derived from a validated session id, so a crafted request cannot
 * walk out of the sessions root.
 *
 * @module @cckbc/dsh-session-recycle-bin
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { cp, open, readFile, readdir, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
// The namespace, not a named import: `zstdDecompressSync` only exists from
// Node 22.15 on, and a named import of an export the runtime does not have is
// a load-time failure for the whole plugin. Read through the object instead.
import zlib from 'node:zlib';

/** Web-server service keys, newest first — the same pair the shipped plugins try. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];

/** Route the browser half calls. */
const ROUTE_PATH = '/plugins/dsh-delete-session/session';

/** A session id is an id, never a path: anything else is a malformed request. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;

/** Largest request body this route buffers. */
const MAX_BODY_BYTES = 65536;

/** Largest batch the page may ask about in one `verify` call. */
const MAX_VERIFY_IDS = 500;

/** Default retention: how long a trashed session stays restorable. */
const DEFAULT_RETENTION_DAYS = 15;

/** How often the running host re-checks for expired entries. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Trash root under DSH home. */
const TRASH_DIR = 'dsh-trash';

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Error codes Windows answers with when a path could not be moved because
 * somebody still holds it open. They are the whole reason a delete moves a log
 * file by file instead of moving its directory.
 */
const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

/** Largest amount of decoded log text read while looking for a session title. */
const LOG_TITLE_BYTES = 4 * 1024 * 1024;

/** Largest number of zstd frames read while looking for a session title. */
const LOG_TITLE_FRAMES = 256;

/** The zstd frame magic: every append to a session log starts one. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Resolve the DSH home directory.
 * @returns absolute path of the state root.
 */
function dshHome() {
  const configured = process.env['DSH_HOME'];
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
  return join(homedir(), '.dsh');
}

/** An error the route answers with a specific status. */
class TrashError extends Error {
  /**
   * @param message - operator-facing message.
   * @param status - HTTP status to answer with.
   * @param code - stable machine-readable code.
   */
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Drain and parse a JSON request body.
 * @param req - the incoming request.
 * @returns the parsed object.
 */
function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onError);
      if (error !== undefined) rejectPromise(error);
      else resolvePromise(value);
    };
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        finish(new Error('request body is too large'));
        req.resume();
        return;
      }
      chunks.push(buffer);
    }
    function onEnd() {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        finish(undefined, {});
        return;
      }
      try {
        const value = JSON.parse(raw);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          finish(new Error('body must be a JSON object'));
          return;
        }
        finish(undefined, value);
      } catch {
        finish(new Error('invalid JSON'));
      }
    }
    function onAbort() {
      finish(new Error('request aborted'));
    }
    function onError() {
      finish(new Error('request failed'));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.once('aborted', onAbort);
    req.once('error', onError);
  });
}

/**
 * Read the facts one projection-cache record carries.
 * @param record - a cache record shaped `{ identity, rows }`.
 * @returns the title, working directory and creation time it knows; a field is
 *   absent when the cache is silent about it.
 */
function readCacheRecord(record) {
  const rows = record?.rows ?? {};
  const title = typeof rows.title?.val === 'string' && rows.title.val !== '' ? rows.title.val : undefined;
  const cwd = typeof record?.identity?.cwd === 'string' && record.identity.cwd !== '' ? record.identity.cwd : undefined;
  const createdAt = typeof record?.identity?.createdAt === 'number' ? record.identity.createdAt : undefined;
  return { title, cwd, createdAt };
}

/**
 * Read a session's projection cache: the title the sidebar shows and the exact
 * working directory, both of which outlive the log that a delete moves away.
 *
 * DSH_HOME/storages keeps the cache in two shapes. A session of this window
 * lives in the shared `session_projcache.json` document under
 * `tables.sessions[id]`; a child session additionally gets its own
 * `session_projcache/sessions/<id>.json` file. Reading only the per-session FILE
 * — which is what this did — finds nothing for an ordinary session, so the entry
 * was stored with its raw session id as its title and no workspace at all: the
 * page then listed ids nobody can tell apart instead of names.
 *
 * @param home - DSH home directory.
 * @param sessionId - the session to describe.
 * @returns a partial descriptor; fields are absent when unknown. `cachePath` is
 *   the per-session file, the one piece of the cache a delete may remove.
 */
function readCacheFacts(home, sessionId) {
  const cachePath = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  const own = (() => {
    try {
      return readCacheRecord(JSON.parse(readFileSync(cachePath, 'utf8'))?.record);
    } catch {
      return {};
    }
  })();
  const shared = (() => {
    try {
      const document = JSON.parse(readFileSync(join(home, 'storages', 'session_projcache.json'), 'utf8'));
      return readCacheRecord(document?.tables?.sessions?.[sessionId]);
    } catch {
      return {};
    }
  })();
  return {
    title: shared.title ?? own.title,
    cwd: shared.cwd ?? own.cwd,
    createdAt: shared.createdAt ?? own.createdAt,
    cachePath,
  };
}

/**
 * Read the Workspace registry's persisted state.
 * @param home - DSH home directory.
 * @returns the parsed document, or null when it is absent or unreadable.
 */
async function readWorkspaceDocument(home) {
  const path = join(home, 'storages', 'workspace.json');
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/**
 * Write the Workspace registry's state atomically.
 * @param home - DSH home directory.
 * @param document - the document to persist.
 */
async function writeWorkspaceDocument(home, document) {
  const path = join(home, 'storages', 'workspace.json');
  const temporary = `${path}.delete-session.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

/**
 * Drop one session id from every account of a Workspace document.
 * @param document - the parsed Workspace state.
 * @param sessionId - the session to forget.
 * @returns whether anything changed.
 */
function forgetSession(document, sessionId) {
  let changed = false;
  const global = document.global;
  if (typeof global === 'object' && global !== null) {
    for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
      const list = global[key];
      if (!Array.isArray(list)) continue;
      const next = list.filter((id) => id !== sessionId);
      if (next.length !== list.length) {
        global[key] = next;
        changed = true;
      }
    }
  }
  const tables = document.tables;
  const workspaces = typeof tables === 'object' && tables !== null ? tables.workspaces : undefined;
  if (typeof workspaces === 'object' && workspaces !== null) {
    for (const record of Object.values(workspaces)) {
      if (typeof record !== 'object' || record === null) continue;
      const list = record.sessionIds;
      if (!Array.isArray(list)) continue;
      const next = list.filter((id) => id !== sessionId);
      if (next.length !== list.length) {
        record.sessionIds = next;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Re-account a restored session under the workspace that owns its directory.
 * @param document - the parsed Workspace state.
 * @param sessionId - the restored session.
 * @param workspacePath - the workspace directory path.
 * @returns whether anything changed.
 */
function accountSession(document, sessionId, workspacePath) {
  const tables = document.tables;
  const workspaces = typeof tables === 'object' && tables !== null ? tables.workspaces : undefined;
  if (typeof workspaces !== 'object' || workspaces === null) return false;
  const wanted = workspacePath.toLowerCase();
  for (const record of Object.values(workspaces)) {
    if (typeof record !== 'object' || record === null) continue;
    if (typeof record.path !== 'string' || record.path.toLowerCase() !== wanted) continue;
    if (!Array.isArray(record.sessionIds)) record.sessionIds = [];
    if (record.sessionIds.includes(sessionId)) return false;
    record.sessionIds = [sessionId, ...record.sessionIds];
    record.updatedAt = new Date().toISOString();
    return true;
  }
  return false;
}

/**
 * Resolve the sessions directory name a working directory maps to.
 *
 * The Harness spells a project directory as `--` + the path with its drive
 * colon dropped, every separator turned into `-`, and every character that is
 * not `[A-Za-z0-9_-]` escaped as `~` plus its four-digit uppercase UTF-16 code
 * unit. So `C:\Users\me\项目` becomes `--C-Users-me-~9879~76EE--`.
 *
 * @param cwd - the session's working directory.
 * @returns the directory name under `<DSH_HOME>/sessions`.
 */
function workspaceSlug(cwd) {
  let body = '';
  for (let index = 0; index < cwd.length; index += 1) {
    const character = cwd[index];
    if (character === ':') continue;
    if (character === '\\' || character === '/') {
      body += '-';
      continue;
    }
    if (/^[A-Za-z0-9_-]$/.test(character)) {
      body += character;
      continue;
    }
    body += `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `--${body}--`;
}

/**
 * Locate the session's log directory under the sessions root.
 * @param home - DSH home directory.
 * @param sessionId - the session to find.
 * @returns the absolute directory path, or undefined.
 */
async function findSessionDirectory(home, sessionId) {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return undefined;
  const candidates = new Set([sessionId, `session-${sessionId}`]);
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    for (const name of candidates) {
      const candidate = join(root, workspace.name, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Absolute path of the trash index. */
function indexPath(home) {
  return join(home, TRASH_DIR, 'index.json');
}

/**
 * Move a directory's contents somewhere else, one entry at a time.
 *
 * Renaming the WHOLE directory is what a delete used to do, and a running app
 * makes that impossible: on Windows, renaming a directory that holds a file with
 * an open handle fails with `EPERM`, so deleting the session the app was showing
 * came back as "the session log is in use" — and stayed that way after a
 * restart, because a resumed session holds its log open again. Renaming the FILE
 * is allowed with that very same handle, so the move is done child by child and
 * only the emptied directory is left over.
 *
 * Every child is either renamed (the payload simply changes place), or copied
 * and then unlinked when the rename was refused, or — if even reading it is
 * refused — reported as stuck so the caller can keep the original instead of
 * pretending the move succeeded.
 *
 * @param source - the directory whose contents move.
 * @param target - the directory that receives them.
 * @returns the names moved, copied, and left stuck in place.
 */
async function moveChildren(source, target) {
  const moved = [];
  const copied = [];
  const stuck = [];
  await mkdir(target, { recursive: true });
  for (const name of await readdir(source).catch(() => [])) {
    const from = join(source, name);
    const to = join(target, name);
    try {
      await rename(from, to);
      moved.push(name);
      continue;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (!LOCKED_CODES.has(error?.code)) throw error;
    }
    try {
      await cp(from, to, { recursive: true, force: true });
      copied.push(name);
    } catch {
      stuck.push(name);
      continue;
    }
    // The payload is safe in the bin now; unlink the original if it lets go.
    await rm(from, { recursive: true, force: true }).catch(() => {});
  }
  return { moved, copied, stuck };
}

/**
 * Report what is still inside a directory a move has emptied.
 *
 * Nothing is ever removed wholesale here. The running app can write into that
 * directory between the listing a move worked from and this call — it is, after
 * all, the session the app has open — and a file this plugin never moved must
 * never be deleted. So a second pass moves whatever appeared, and the directory
 * itself is dropped only once it is verifiably empty.
 *
 * @param directory - the directory to empty and then remove.
 * @param target - where anything that appeared in the meantime belongs.
 * @param stuck - names the first pass could not preserve elsewhere; anything but
 *   an empty list means the directory must be left exactly as it is.
 * @returns the names still on disk, `[]` when the directory is gone.
 */
async function dropEmptied(directory, target, stuck) {
  if (stuck.length > 0) return await readdir(directory).catch(() => []);
  const again = await moveChildren(directory, target);
  const left = await readdir(directory).catch(() => []);
  if (left.length > 0 || again.stuck.length > 0) return await readdir(directory).catch(() => []);
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  return await readdir(directory).catch(() => []);
}

/**
 * Decode as much of a concatenated zstd log as the budgets allow.
 *
 * A session log is not one zstd frame: every flush appends another, so the head
 * of the file is one frame and the rest are frames after it. Node's one-shot and
 * streaming decoders both stop at the end of the first frame, which is why the
 * frames are walked by hand — the magic finds the boundaries, and a frame end
 * that does not decode is either a magic that happens to sit inside a frame's
 * payload or a half-written tail, so the walk lengthens the slice until one
 * decodes. Both budgets keep a listing cheap on a long session.
 *
 * @param buffer - the bytes read from the log.
 * @returns the decoded JSONL text of the frames that decoded.
 */
function decodeLogFrames(buffer) {
  if (typeof zlib.zstdDecompressSync !== 'function') return '';
  const starts = [];
  for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + 4)) starts.push(at);
  let text = '';
  let index = 0;
  let frames = 0;
  while (index < starts.length && text.length < LOG_TITLE_BYTES && frames < LOG_TITLE_FRAMES) {
    let decoded = false;
    for (let end = index + 1; end <= starts.length; end += 1) {
      const stop = end < starts.length ? starts[end] : buffer.length;
      try {
        text += zlib.zstdDecompressSync(buffer.subarray(starts[index], stop)).toString('utf8');
        index = end;
        frames += 1;
        decoded = true;
        break;
      } catch {
        /* not a frame end: try the next candidate */
      }
    }
    if (!decoded) index += 1;
  }
  return text;
}

/**
 * Read the name a log records for its own session.
 *
 * DSH writes a `session/title` record when it names a session — first a fallback
 * built from the first prompt, then the model's title — and later again on a
 * rename. The last one in the log is the name the sidebar shows, which makes the
 * payload the one place that still knows what a session was called after every
 * cache describing it is gone.
 *
 * @param text - decoded JSONL.
 * @returns the last recorded title, or undefined.
 */
function titleFromLog(text) {
  let title;
  for (const line of text.split('\n')) {
    if (!line.includes('"session/title"')) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type !== 'session/title') continue;
      if (typeof record.data?.title === 'string' && record.data.title !== '') title = record.data.title;
    } catch {
      /* a record the read cut in half */
    }
  }
  return title;
}

/**
 * Read the header line a session log starts with, and the name it records.
 *
 * The first record of `<session dir>/session.v4.jsonl.zstd` is
 * `{"type":"session","id":…,"cwd":…,"createdAt":…}` in clear text inside the
 * compressed stream — the one place that still knows a session's working
 * directory once every cache describing it is gone. It is only ever a fallback,
 * and only when this Node can decode zstd (22.15+): a log that cannot be read
 * simply yields nothing.
 *
 * @param directory - a directory holding the log.
 * @returns the header's session id, working directory, creation time and title.
 */
async function readLogFacts(directory) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch {
    return {};
  }
  const name = names.find((candidate) => candidate.endsWith('.jsonl.zstd'))
    ?? names.find((candidate) => candidate.endsWith('.jsonl'));
  if (name === undefined) return {};
  const path = join(directory, name);
  let text;
  if (name.endsWith('.zstd')) {
    const size = await stat(path).then((stats) => stats.size, () => 0);
    // The whole log when it is small enough to hold a later rename, its head
    // otherwise: decoding is what costs, and the title is written early.
    const limit = Math.max(Math.min(size, LOG_TITLE_BYTES), 1);
    let raw;
    try {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(limit);
        const { bytesRead } = await handle.read(buffer, 0, limit, 0);
        raw = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return {};
    }
    text = decodeLogFrames(raw);
  } else {
    try {
      text = (await readFile(path, 'utf8')).slice(0, LOG_TITLE_BYTES);
    } catch {
      return {};
    }
  }
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  if (line === undefined) return {};
  const title = titleFromLog(text);
  try {
    const header = JSON.parse(line);
    return {
      sessionId: typeof header?.id === 'string' ? header.id : undefined,
      cwd: typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined,
      createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
      title,
    };
  } catch {
    return { title };
  }
}

/**
 * Take a session's own projection-cache file along with its payload.
 *
 * That file is where the sidebar's title for a session comes from — the name
 * the page lists it under. It used to be deleted with the log, which cost the
 * session its name for good: DSH rebuilds the cache only when it reads a
 * session, and a session whose log has just left is not read again, so a
 * restore put back a log whose row was titled with its raw id. Moving it keeps
 * "which session is which" answerable through delete, restore and a second
 * delete.
 *
 * @param cachePath - the per-session cache file.
 * @param target - where the payload keeps it.
 * @returns whether it was taken along.
 */
async function takeCacheAside(cachePath, target) {
  if (!existsSync(cachePath)) return false;
  try {
    await rename(cachePath, target);
    return true;
  } catch {
    /* the file is open, or the two paths are on different volumes */
  }
  try {
    await cp(cachePath, target, { force: true });
    await rm(cachePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a carried projection-cache file back where DSH reads it.
 * @param source - the copy kept with the payload.
 * @param target - the per-session cache path.
 * @returns whether it was put back.
 */
async function returnCacheAside(source, target) {
  if (!existsSync(source)) return false;
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
    return true;
  } catch {
    /* fall through to the copy */
  }
  try {
    await cp(source, target, { force: true });
    await rm(source, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the projection cache a payload carried off, if it carried one.
 * @param home - DSH home directory.
 * @param entry - the bin entry.
 * @returns the title, working directory and creation time it knows.
 */
async function readCarriedFacts(home, entry) {
  const path = join(home, TRASH_DIR, entryDirectoryName(entry), 'cache.json');
  try {
    return readCacheRecord(JSON.parse(await readFile(path, 'utf8'))?.record);
  } catch {
    return {};
  }
}

/**
 * Delete a log that appeared again at a session's original place.
 *
 * The running Host keeps a deleted session in memory, so it can write the log
 * back to disk after the delete moved it away. "Delete forever" has to take
 * that one too: otherwise the payload leaves the bin at the retention deadline
 * and the session comes back from the dead — listed, openable, and impossible
 * to delete because there is nothing left in the bin to remove.
 *
 * @param home - DSH home directory.
 * @param sessionId - the session whose log is checked.
 * @returns whether a log was found and removed.
 */
async function removeResurrectedLog(home, sessionId) {
  const directory = await findSessionDirectory(home, sessionId);
  if (directory === undefined) return false;
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  return !existsSync(directory);
}

/**
 * The running process's own Workspace registry, when it has one.
 *
 * This is the same service the sidebar draws its tree from
 * (`ctx.workspaceRegistry`, provided by the shipped `@deepseek-ai/dsh-workspace`),
 * and the only thing that knows which sessions the window currently lists. It is
 * read with `ctx.get(name)` rather than as a property: a Cordis context throws on
 * an undeclared service access, and this module is also imported by tests that
 * run it without any container at all.
 *
 * @param host - the plugin context, or anything answering `get`.
 * @returns the registry, or undefined outside a running Host.
 */
function workspaceRegistryOf(host) {
  try {
    return host?.get?.('workspaceRegistry') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the registered Workspace that owns a directory, or that accounts a session.
 * @param registry - the running Workspace registry.
 * @param cwd - the session's working directory, when it is known.
 * @param sessionId - the session, for the id search.
 * @returns the workspace entity, or undefined.
 */
async function findWorkspace(registry, cwd, sessionId) {
  if (typeof cwd === 'string' && cwd !== '' && typeof registry.resolveByPath === 'function') {
    try {
      const resolved = await registry.resolveByPath(cwd);
      if (resolved !== undefined && resolved !== null) return resolved;
    } catch {
      /* the directory is gone: fall through to the id search */
    }
  }
  const entities = registry.entities;
  if (entities !== undefined && entities !== null && typeof entities.values === 'function') {
    for (const entity of entities.values()) {
      if (Array.isArray(entity?.sessionIds) && entity.sessionIds.includes(sessionId)) return entity;
    }
  }
  return undefined;
}

/**
 * Hand a restored session back to the running Host.
 *
 * Moving the log back and editing `workspace.json` restores the session on DISK,
 * and that is all it does: the running app already loaded that file, and nothing
 * tells it to read it again. The restored row therefore stayed invisible — the
 * user restored a session, watched the bin empty, and saw no row — until the next
 * restart. The Harness owns the answer to "an on-disk session belongs to this
 * workspace again": `Workspace.attachSession`, which validates the log's own
 * header against the workspace directory and makes the membership durable; it is
 * what the Host itself calls when it adopts a session (`session/new` carrying an
 * existing id). Calling it here reaches the running window at once — the registry
 * persists the record and pushes it to the page, so the row returns without a
 * restart.
 *
 * @param host - the plugin context.
 * @param sessionId - the session that was restored.
 * @param cwd - its working directory.
 * @returns whether the running Host took it back.
 */
async function attachInRunningHost(host, sessionId, cwd) {
  const registry = workspaceRegistryOf(host);
  if (registry === undefined) return false;
  const workspace = await findWorkspace(registry, cwd, sessionId);
  if (workspace === undefined || typeof workspace.attachSession !== 'function') return false;
  await workspace.attachSession(sessionId);
  return true;
}

/**
 * Report which of the given sessions have no log on disk.
 *
 * The page hides a deleted row until its log is back, and only this side can
 * answer whether it is: a session moved into the bin, one purged out of it and
 * one swept after 15 days all have no log, while a restored one does. The bin's
 * own contents cannot stand in for that answer on their own — purging removes
 * the entry AND the payload, so a page that decided from the listing alone let
 * the row come back from the dead: listed, openable out of the running Host's
 * memory, and undeletable because there was nothing left to move. `verifiedMissing`
 * combines the two, and this half is the one that knows the disk.
 *
 * @param home - DSH home directory.
 * @param sessionIds - the ids the page is currently hiding.
 * @returns the subset with no log directory, in the order asked.
 */
async function missingLogs(home, sessionIds) {
  const wanted = new Set();
  for (const sessionId of Array.isArray(sessionIds) ? sessionIds.slice(0, MAX_VERIFY_IDS) : []) {
    if (typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)) wanted.add(sessionId);
  }
  if (wanted.size === 0) return [];
  const root = join(home, 'sessions');
  const found = new Set();
  let workspaces = [];
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    workspaces = [];
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    let names = [];
    try {
      names = await readdir(join(root, workspace.name));
    } catch {
      names = [];
    }
    for (const name of names) {
      // The same two spellings `findSessionDirectory` accepts.
      if (wanted.has(name)) found.add(name);
      else if (name.startsWith('session-') && wanted.has(name.slice('session-'.length))) found.add(name.slice('session-'.length));
    }
  }
  return [...wanted].filter((id) => !found.has(id));
}

/**
 * Read the trash index.
 * @param home - DSH home directory.
 * @returns the index document with a normalised `entries` array.
 */
async function readIndex(home) {
  try {
    const document = JSON.parse(await readFile(indexPath(home), 'utf8'));
    const entries = Array.isArray(document?.entries) ? document.entries : [];
    return {
      version: typeof document?.version === 'number' ? document.version : 1,
      retentionDays: typeof document?.retentionDays === 'number' && document.retentionDays > 0 ? document.retentionDays : DEFAULT_RETENTION_DAYS,
      entries,
    };
  } catch {
    return { version: 1, retentionDays: DEFAULT_RETENTION_DAYS, entries: [] };
  }
}

/**
 * Persist the trash index.
 * @param home - DSH home directory.
 * @param index - the index document.
 */
async function writeIndex(home, index) {
  const path = indexPath(home);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

/** One entry's directory name inside the trash root. */
function entryDirectoryName(entry) {
  return typeof entry.directory === 'string' && entry.directory !== ''
    ? entry.directory
    : `${String(entry.trashedAt).replaceAll(':', '').replaceAll('.', '')}-${entry.sessionId}`;
}

/**
 * Delete one trash entry's payload, entry directory and all.
 *
 * A log the running Host wrote back to the session's original place is removed
 * as well: the entry is what hides the row, and once it is gone the row would
 * come back unless that log goes with it.
 *
 * @param home - DSH home directory.
 * @param entry - the entry to remove.
 * @returns the directory that was removed.
 */
async function removeEntryPayload(home, entry) {
  const directory = join(home, TRASH_DIR, entryDirectoryName(entry));
  await rm(directory, { recursive: true, force: true });
  await removeResurrectedLog(home, entry.sessionId);
  return directory;
}

/**
 * Purge every entry whose retention has expired.
 * @param home - DSH home directory.
 * @returns the ids that were purged.
 */
async function purgeExpired(home) {
  const index = await readIndex(home);
  const now = Date.now();
  const keep = [];
  const purged = [];
  for (const entry of index.entries) {
    const expiresAt = Number(entry.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      await removeEntryPayload(home, entry);
      purged.push(entry.sessionId);
      continue;
    }
    keep.push(entry);
  }
  if (purged.length > 0) {
    index.entries = keep;
    await writeIndex(home, index);
  }
  return purged;
}

/**
 * Rewrite one entry's `meta.json`, keeping the fields only that file holds.
 * @param home - DSH home directory.
 * @param entry - the corrected index entry.
 */
async function refreshEntryMeta(home, entry) {
  const path = join(home, TRASH_DIR, entryDirectoryName(entry), 'meta.json');
  let stored = {};
  try {
    stored = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    stored = {};
  }
  await writeFile(path, `${JSON.stringify({ ...stored, ...entry }, null, 2)}\n`, 'utf8');
}

/**
 * Recover the title and workspace of entries that were stored without them.
 *
 * An entry written before the projection cache was read correctly keeps its raw
 * session id as its title and no working directory, which is exactly what the
 * page showed. Both are derived facts that outlive the log, so every listing
 * tries again and persists whatever it recovers, making it a one-off repair
 * rather than a permanent blank. Three sources are tried, best first: the
 * projection cache carried off with the payload, the caches still on this
 * machine, and the log's own records — its header line for the working
 * directory, and the `session/title` it wrote for the name, both of which
 * survive every cache being gone.
 *
 * @param home - DSH home directory.
 * @param index - the trash index, corrected in place.
 * @returns how many entries were repaired.
 */
async function repairEntries(home, index) {
  const repaired = [];
  for (const entry of index.entries) {
    const missingTitle = typeof entry.title !== 'string' || entry.title === '' || entry.title === entry.sessionId;
    const missingCwd = typeof entry.cwd !== 'string' || entry.cwd === '';
    const missingCreated = entry.createdAt === null || entry.createdAt === undefined;
    if (!missingTitle && !missingCwd && !missingCreated) continue;
    const carried = await readCarriedFacts(home, entry);
    const cached = readCacheFacts(home, entry.sessionId);
    let changed = false;
    let title = carried.title ?? cached.title;
    let cwd = carried.cwd ?? cached.cwd;
    let createdAt = carried.createdAt ?? cached.createdAt;
    let settledCwd = typeof entry.cwd === 'string' && entry.cwd !== '';
    if (missingTitle || !settledCwd || createdAt === undefined) {
      // The payload's own log is the fallback: what was left behind lives in the
      // original directory, which only a deferred move still has.
      const log = await readLogFacts(join(home, TRASH_DIR, entryDirectoryName(entry), 'log'));
      const source = log.cwd === undefined && typeof entry.originalDirectory === 'string'
        ? await readLogFacts(entry.originalDirectory)
        : log;
      title = title ?? source.title;
      if (!settledCwd && typeof source.cwd === 'string' && source.cwd !== '') {
        cwd = source.cwd;
        settledCwd = true;
      }
      createdAt = createdAt ?? source.createdAt;
    }
    if (missingTitle && typeof title === 'string' && title !== '') {
      entry.title = title;
      changed = true;
    }
    if (missingCwd && typeof cwd === 'string' && cwd !== '') {
      entry.cwd = cwd;
      entry.workspaceSlug = workspaceSlug(cwd);
      changed = true;
    }
    if (missingCreated && typeof createdAt === 'number') {
      entry.createdAt = createdAt;
      changed = true;
    }
    if (changed) repaired.push(entry);
  }
  if (repaired.length === 0) return 0;
  await writeIndex(home, index);
  for (const entry of repaired) await refreshEntryMeta(home, entry);
  return repaired.length;
}

/**
 * Move one session's log directory into the recycle bin.
 *
 * A session with nothing on disk is still a session the user can see and open:
 * the Host keeps its registry in memory, so one that was deleted and then
 * purged out of the bin — or one that never had a log, like an in-memory child
 * session — stays listed until the app restarts. "Delete" then means the only
 * thing left to do: forget it in the workspace ACCOUNT on disk, so it does not
 * come back at the next boot. The row on screen is hidden by the page, which is
 * the half that owns hiding.
 *
 * @param home - DSH home directory.
 * @param sessionId - the session to trash.
 * @param request - the whole request body; its `title` is the row's own name on
 *   the page, used only when no cache on this machine still knows one.
 * @returns the stored entry, or `{ moved: false }` when there was no payload.
 */
async function trashSession(home, sessionId, request) {
  const directory = await findSessionDirectory(home, sessionId);
  if (directory === undefined) {
    let forgotAccount = false;
    const document = await readWorkspaceDocument(home);
    if (document !== null && forgetSession(document, sessionId)) {
      await writeWorkspaceDocument(home, document);
      forgotAccount = true;
    }
    return { sessionId, moved: false, forgotAccount };
  }
  const facts = readCacheFacts(home, sessionId);
  // The page can name the row it just deleted even when this machine cannot:
  // a session created moments ago has no cache record yet, and the row is
  // already on screen with whatever name the sidebar shows. The log's own
  // `session/title` record is the third source, and the one that outlives every
  // cache — it is what restores the names of sessions deleted before this was
  // read at all.
  const hint = typeof request?.['title'] === 'string' ? request['title'].trim() : '';
  // Reading the log costs a zstd pass, so it happens only for what no cache
  // could answer — which is the whole reason it is read at all.
  const needsLog = facts.title === undefined || facts.cwd === undefined || facts.createdAt === undefined;
  const logFacts = needsLog ? await readLogFacts(directory) : {};
  const cwd = facts.cwd ?? logFacts.cwd;
  const title = facts.title ?? (hint !== '' ? hint : logFacts.title);
  const index = await readIndex(home);
  let bytes = 0;
  for (const entryName of await readdir(directory).catch(() => [])) {
    const stats = await stat(join(directory, entryName)).catch(() => undefined);
    if (stats !== undefined && stats.isFile()) bytes += stats.size;
  }
  const now = Date.now();
  const stamp = new Date(now).toISOString().replaceAll(':', '').replaceAll('.', '');
  const entry = {
    sessionId,
    directory: `${stamp}-${sessionId}`,
    title: title ?? sessionId,
    cwd: cwd ?? null,
    workspaceSlug: cwd !== undefined ? workspaceSlug(cwd) : null,
    logDirectoryName: basename(directory),
    bytes,
    createdAt: facts.createdAt ?? logFacts.createdAt ?? null,
    trashedAt: new Date(now).toISOString(),
    trashedAtMs: now,
    expiresAt: now + index.retentionDays * DAY_MS,
    retentionDays: index.retentionDays,
  };
  const target = join(home, TRASH_DIR, entry.directory);
  // The entry directory must exist before the log can be moved into it, and the
  // log moves file by file: the app may still hold it open, and a directory
  // holding an open file cannot be renamed on Windows.
  const transfer = await moveChildren(directory, join(target, 'log'));
  const leftover = await dropEmptied(directory, join(target, 'log'), transfer.stuck);
  const cacheFile = await takeCacheAside(facts.cachePath, join(target, 'cache.json'));
  const settled = {
    ...entry,
    leftover,
    cacheFile,
    deferred: transfer.stuck.length > 0,
  };
  await writeFile(
    join(target, 'meta.json'),
    `${JSON.stringify({ ...settled, originalDirectory: directory, transfer }, null, 2)}\n`,
    'utf8',
  );

  let forgotAccount = false;
  const document = await readWorkspaceDocument(home);
  if (document !== null && forgetSession(document, sessionId)) {
    await writeWorkspaceDocument(home, document);
    forgotAccount = true;
  }
  /*
   * The running app is deliberately NOT told to drop the session.
   *
   * It looks like the symmetric thing to do next to the restore's attach, and
   * it was tried: `detachSession` takes the id out of the workspace record the
   * page groups rows by, and the app has exactly one place for a session no
   * workspace accounts for — the ungrouped bucket. A deleted row is hidden by
   * this plugin's own styles, so what the user saw was a "未分组" heading with
   * nothing under it, and `startSession()` — which opens the next session in
   * the workspace that accounts the one in the main view — lost its answer and
   * fell back to the most recently used workspace, moving the composer out of
   * the directory the user was working in. The row leaves the page because the
   * page hides it, and it leaves the disk account here; the window's memory
   * follows at the next start, which is when it re-reads this file anyway.
   */
  index.entries = [settled, ...index.entries.filter((candidate) => candidate.sessionId !== sessionId)];
  await writeIndex(home, index);
  return { ...settled, moved: true, forgotAccount };
}

/**
 * Finish moving whatever a delete could not take the first time.
 *
 * Windows allows moving an open file but not a directory holding one, and the
 * copy that stands in for a refused rename can be refused too when a handle
 * denies reading. Anything left behind is retried on every listing: as soon as
 * the app lets go of the file — the session is closed, or the app restarts —
 * the rest of the log joins the payload it belongs to.
 *
 * @param home - DSH home directory.
 * @param index - the trash index, corrected in place.
 * @returns how many entries changed.
 */
async function settleLeftovers(home, index) {
  let changed = 0;
  for (const entry of index.entries) {
    if (!Array.isArray(entry.leftover) || entry.leftover.length === 0) continue;
    const original = typeof entry.originalDirectory === 'string' && entry.originalDirectory !== ''
      ? entry.originalDirectory
      : await findSessionDirectory(home, entry.sessionId);
    if (original === undefined) {
      entry.leftover = [];
      changed += 1;
      continue;
    }
    const transfer = await moveChildren(original, join(home, TRASH_DIR, entryDirectoryName(entry), 'log'));
    const left = await dropEmptied(original, join(home, TRASH_DIR, entryDirectoryName(entry), 'log'), transfer.stuck);
    if (JSON.stringify(left) !== JSON.stringify(entry.leftover)) {
      entry.leftover = left;
      entry.deferred = transfer.stuck.length > 0;
      changed += 1;
    }
  }
  if (changed > 0) await writeIndex(home, index);
  return changed;
}

/**
 * Move same-named files out of the way before a payload takes their place.
 *
 * A restored session can find its own directory already re-created: the running
 * Host still had the session in memory and wrote its log again after the delete.
 * The payload is the history the user asked to keep, so it takes the canonical
 * name; what appeared meanwhile is kept beside it rather than thrown away, and
 * nothing is left in a state the app cannot read.
 *
 * @param source - the payload's log directory.
 * @param target - the session directory it is moving into.
 * @param stamp - a suffix that makes the aside name unique.
 * @returns the names moved aside.
 */
async function displaceCollisions(source, target, stamp) {
  const displaced = [];
  for (const name of await readdir(source).catch(() => [])) {
    const existing = join(target, name);
    if (!existsSync(existing)) continue;
    const aside = `${existing}.replaced-${stamp}`;
    try {
      await rename(existing, aside);
      displaced.push(basename(aside));
    } catch {
      /* an unremovable file is replaced by the payload below */
    }
  }
  return displaced;
}

/**
 * Restore one trashed session to the workspace it came from.
 *
 * The payload moves back file by file for the same reason it left that way: the
 * app may be holding the file open, and a directory holding an open file cannot
 * be renamed on Windows. Refusing with "this session is already stored in that
 * workspace" — which is what an existing directory used to mean — told the user
 * their log was in use when it was in fact already sitting where it belongs.
 *
 * @param home - DSH home directory.
 * @param sessionId - the session to restore.
 * @param host - the plugin context, so the running window learns about it too.
 * @returns the restoration report.
 */
async function restoreSession(home, sessionId, host) {
  const index = await readIndex(home);
  const entry = index.entries.find((candidate) => candidate.sessionId === sessionId);
  if (entry === undefined) {
    throw new TrashError('this session is not in the recycle bin', 404, 'not-trashed');
  }
  const directory = join(home, TRASH_DIR, entryDirectoryName(entry));
  let meta = entry;
  try {
    meta = { ...entry, ...JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')) };
  } catch {
    /* the index copy is enough */
  }
  const slug = typeof meta.workspaceSlug === 'string' && meta.workspaceSlug !== ''
    ? meta.workspaceSlug
    : typeof meta.cwd === 'string' && meta.cwd !== ''
      ? workspaceSlug(meta.cwd)
      : null;
  if (slug === null) {
    throw new TrashError('this entry does not record the workspace it belongs to', 409, 'no-workspace');
  }
  const name = typeof meta.logDirectoryName === 'string' && meta.logDirectoryName !== '' ? meta.logDirectoryName : sessionId;
  const target = join(home, 'sessions', slug, name);
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  // The workspace directory can be gone if it was never re-created after a move;
  // `moveChildren` creates the target directory itself.
  const displaced = await displaceCollisions(join(directory, 'log'), target, stamp);
  const transfer = await moveChildren(join(directory, 'log'), target);
  const leftover = await dropEmptied(join(directory, 'log'), target, transfer.stuck);
  const cacheReturned = await returnCacheAside(
    join(directory, 'cache.json'),
    join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`),
  );
  if (leftover.length > 0) {
    // The payload could not be moved back — it stays in the bin, where it is
    // safe, and the entry stays with it so the user can try again.
    await writeIndex(home, index);
    throw new TrashError('the session log is in use and could not be moved back; stop or close that session first', 409, 'locked');
  }
  await rm(directory, { recursive: true, force: true }).catch(() => {});

  /*
   * The window comes first, the file second. Asking the running Host to attach
   * the session both makes the membership durable (the registry writes its own
   * record) and pushes the change to the page, which is what actually puts the
   * row back without a restart; editing `workspace.json` alone restores the
   * session on disk and nothing else, because the app read that file at startup.
   * The file edit still runs, as the fallback for a Host that would not take the
   * session back and for a machine with no running app at all.
   */
  let attached = false;
  if (typeof meta.cwd === 'string' && meta.cwd !== '') {
    attached = await attachInRunningHost(host, sessionId, meta.cwd).catch((error) => {
      host?.logger?.warn?.(`delete-session: the running host would not take '${sessionId}' back: ${String(error)}`);
      return false;
    });
  }

  let reaccounted = false;
  if (typeof meta.cwd === 'string' && meta.cwd !== '') {
    const document = await readWorkspaceDocument(home);
    if (document !== null && accountSession(document, sessionId, meta.cwd)) {
      await writeWorkspaceDocument(home, document);
      reaccounted = true;
    }
  }
  index.entries = index.entries.filter((candidate) => candidate.sessionId !== sessionId);
  await writeIndex(home, index);
  return {
    sessionId,
    restoredTo: target,
    workspacePath: typeof meta.cwd === 'string' && meta.cwd !== '' ? meta.cwd : null,
    reaccounted,
    attached,
    displaced,
    cacheReturned,
  };
}

/**
 * Answer which of the asked sessions the page must keep hidden.
 *
 * A row stays hidden while its session has no log on disk — and also while the
 * bin still holds a payload for it, which is the same statement for a session
 * the app wrote back to disk after the delete (the Host keeps deleted sessions
 * in memory, and a delete that could only take part of the log leaves the rest
 * where it was until it can be moved). Both are positive reasons to hide: a row
 * comes back only when its log is on disk AND the bin has nothing for it, which
 * is exactly a restore.
 *
 * @param home - DSH home directory.
 * @param sessionIds - the ids the page is currently hiding.
 * @returns the subset that must stay hidden, in the order asked.
 */
async function verifiedMissing(home, sessionIds) {
  const asked = Array.isArray(sessionIds)
    ? sessionIds.slice(0, MAX_VERIFY_IDS).filter((id) => typeof id === 'string' && SESSION_ID_PATTERN.test(id))
    : [];
  if (asked.length === 0) return [];
  const hidden = new Set(await missingLogs(home, asked));
  const index = await readIndex(home);
  for (const entry of index.entries) hidden.add(entry.sessionId);
  return asked.filter((id) => hidden.has(id));
}

/**
 * Apply one recycle-bin operation.
 * @param home - DSH home directory.
 * @param action - the requested action.
 * @param sessionId - the target session, where the action needs one.
 * @param request - the whole request body, for the actions that carry more.
 * @param host - the plugin context, so a restore can reach the running window.
 * @returns the operation's report.
 */
async function applyAction(home, action, sessionId, request, host) {
  if (action === 'list') {
    const purged = await purgeExpired(home);
    const index = await readIndex(home);
    await settleLeftovers(home, index);
    await repairEntries(home, index);
    const now = Date.now();
    return {
      retentionDays: index.retentionDays,
      entries: index.entries.map((entry) => ({
        sessionId: entry.sessionId,
        title: entry.title,
        cwd: entry.cwd,
        bytes: entry.bytes,
        trashedAt: entry.trashedAt,
        expiresAt: entry.expiresAt,
        daysLeft: Math.max(0, Math.ceil((Number(entry.expiresAt) - now) / DAY_MS)),
      })),
      purged,
    };
  }
  if (action === 'empty') {
    const index = await readIndex(home);
    const removed = [];
    for (const entry of index.entries) {
      await removeEntryPayload(home, entry);
      removed.push(entry.sessionId);
    }
    index.entries = [];
    await writeIndex(home, index);
    return { removed };
  }
  if (action === 'verify') {
    return { missing: await verifiedMissing(home, request?.sessionIds) };
  }
  if (sessionId === '') throw new TrashError('a valid sessionId is required', 400, 'invalid-session');
  // Deleting is deleting. The Host's archive set is the user's own
  // organisation tool — an archived session stays listed, greyed, until the
  // sidebar filter hides it — so this plugin must NOT touch it: pushing a
  // deleted session into that set files it under "archived" and makes it show
  // up in the archive views. The deleted row is hidden by the page's own
  // ledger instead (see the client half).
  if (action === 'delete') return trashSession(home, sessionId, request);
  if (action === 'restore') return restoreSession(home, sessionId, host);
  if (action === 'purge') {
    const index = await readIndex(home);
    const entry = index.entries.find((candidate) => candidate.sessionId === sessionId);
    if (entry === undefined) throw new TrashError('this session is not in the recycle bin', 404, 'not-trashed');
    await removeEntryPayload(home, entry);
    index.entries = index.entries.filter((candidate) => candidate.sessionId !== sessionId);
    await writeIndex(home, index);
    return { sessionId, purged: true };
  }
  throw new TrashError(`unknown action '${action}'`, 400, 'unknown-action');
}

/**
 * Services this plugin reads. Declaring them is what makes Cordis hand them
 * over: a plugin context is a Proxy that throws on every undeclared service
 * (`cannot get property "…" without inject`), and a declared service that no
 * provider supplies yet leaves this fiber `pending` — which the Web boot
 * audit reports as a failed startup entry. Both are provided by the web row
 * set (`@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-host-connection`),
 * and the route exists only in the Web GUI, so the dependency is real rather
 * than incidental: without a Web server this plugin has nothing to serve.
 */
export const inject = ['webServer', 'connection'];
/**
 * Mount the recycle-bin route and start the retention sweep.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const register = () => {
    const server = WEB_SERVER_KEYS.map((key) => ctx.get(key)).find((value) => value !== undefined);
    if (server === undefined || typeof server.register !== 'function') return;
    const connection = ctx.get('connection');
    ctx.effect(() => server.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        const reply = (status, payload) => {
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify(payload));
        };
        // Raw Web routes bypass the Connection's own fence, so this route
        // carries the same authentication gate the sibling plugin routes use.
        if (connection !== undefined && typeof connection.requestRejection === 'function') {
          const rejection = connection.requestRejection(req);
          if (rejection !== undefined) {
            reply(rejection, {
              error: rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'authentication unavailable',
            });
            return;
          }
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (error) {
          reply(400, { error: error instanceof Error ? error.message : 'invalid request body' });
          return;
        }
        // A request that names no action is a read: list. A destructive action
        // must always be named explicitly.
        const action = typeof payload['action'] === 'string' && payload['action'] !== '' ? payload['action'] : 'list';
        const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'].trim() : '';
        if (action !== 'list' && action !== 'empty' && action !== 'verify' && !SESSION_ID_PATTERN.test(sessionId)) {
          reply(400, { error: 'a valid sessionId is required' });
          return;
        }
        try {
          const report = await applyAction(dshHome(), action, sessionId, payload, ctx);
          reply(200, { ok: true, action, ...report });
        } catch (error) {
          if (error instanceof TrashError) {
            ctx.logger?.warn?.(`delete-session: ${action} ${sessionId} refused (${error.code})`);
            reply(error.status, { error: error.message, code: error.code });
            return;
          }
          const code = error?.code;
          if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY') {
            ctx.logger?.warn?.(`delete-session: ${sessionId} is locked (${code})`);
            reply(409, { error: 'the session log is in use and could not be moved; stop or close that session first', code: 'locked' });
            return;
          }
          ctx.logger?.warn?.(`delete-session: ${action} ${sessionId} failed: ${String(error)}`);
          reply(500, { error: error instanceof Error ? error.message : 'the operation failed' });
        }
      },
    }), 'delete-session: session route');
  };
  register();
  // The Web server may bind after this plugin activates; retry on each binding.
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name)) register();
  });

  // Retention sweep: expired entries are purged while the app runs, so the
  // recycle bin never needs manual emptying.
  ctx.effect(() => {
    const sweep = () => {
      purgeExpired(dshHome()).then((purged) => {
        if (purged.length > 0) ctx.logger?.info?.(`delete-session: purged ${String(purged.length)} expired session(s)`);
      }).catch((error) => {
        ctx.logger?.warn?.(`delete-session: retention sweep failed: ${String(error)}`);
      });
    };
    sweep();
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      clearInterval(timer);
    };
  }, 'delete-session: retention sweep');
}
