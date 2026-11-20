// SPDX-License-Identifier: MIT
// Remote-synced persistent disk: a CowDisk overlay store that keeps the
// disk in a local store (IndexedDB) and mirrors it to a remote backend in
// the background, so the same disk opens in any browser.
//
// Model
//   * The disk is cut into chunks of CHUNK_BLOCKS 4 KiB blocks (256 KiB).
//     A chunk is stored remotely under the SHA-256 of its canonical bytes
//     (immutable, deduplicated, cacheable); a small manifest maps chunk
//     index -> "<hash>:<present-mask>" and carries a revision number.
//   * Writes go to the local store first (so the guest never waits for the
//     network). A debounced push uploads the chunks that changed, then
//     commits a new manifest with compare-and-swap on the previous one.
//     The push reads all dirty blocks in one local transaction, so the
//     remote state is always the state after some complete guest flush:
//     ext4 recovers from it like from a power cut.
//   * One writer at a time: a lease on the server (owner id + TTL, renewed by
//     a heartbeat) decides which browser may push; the manifest CAS is the
//     safety net if a lease is ever lost.
//   * Opening: the manifest is fetched first. If the remote is newer than
//     what this browser last synced and there are no unpushed local changes,
//     the local cache is dropped and the remote disk is adopted, its chunks
//     read lazily. Unpushed local changes against a newer remote are a
//     conflict, never merged (an ext4 image cannot be).
//
// Only disks over a ZeroBase are supported (the data disk): a block that
// reads as zeros is not stored remotely.
import type { OverlayStore, StoreIndex } from "../core/block.ts";

const BLOCK = 4096;
/** Blocks per remote chunk (a 64-bit present mask describes one). */
export const CHUNK_BLOCKS = 64;
const CHUNK_BYTES = CHUNK_BLOCKS * BLOCK;

// ---------------------------------------------------------------------------
// Protocol types

export interface Manifest {
	v: 1;
	/** Increases by one on every committed push. */
	rev: number;
	/** Random id of this disk's history; changes when the remote is reset. */
	uid: string;
	identity: string;
	/** Chunk index -> "<sha256 hex>:<16 hex digits present mask>". */
	chunks: Record<string, string>;
	/** The CowDisk write generation of the pushed state. */
	gen: number;
	/** false until the first push of a seeded disk (a placeholder). */
	seeded: boolean;
	updatedAt: number;
}

export type LeaseResult = { ok: true; until: number } | { ok: false; owner: string; until: number };
export type PutManifestResult = { etag: string } | "conflict" | "lease";

/** What a server must provide. HttpBackend speaks it over REST; tests use MemBackend. */
export interface RemoteBackend {
	getManifest(): Promise<{ manifest: Manifest; etag: string } | null>;
	/** Compare-and-swap: ifMatch null creates (fails if one exists). "lease": `owner` does not hold the lease. */
	putManifest(m: Manifest, ifMatch: string | null, owner: string): Promise<PutManifestResult>;
	acquireLease(owner: string, ttlMs: number, steal?: boolean): Promise<LeaseResult>;
	releaseLease(owner: string): Promise<void>;
	getChunk(hash: string): Promise<Uint8Array>;
	/** Idempotent: the same hash always has the same content. */
	putChunk(hash: string, data: Uint8Array): Promise<void>;
}

export class RemoteLeaseError extends Error {
	owner: string;
	until: number;
	constructor(owner: string, until: number) {
		super(`the disk is open in another browser (lease held until ${new Date(until).toISOString()})`);
		this.name = "RemoteLeaseError";
		this.owner = owner;
		this.until = until;
	}
}

export class RemoteConflictError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "RemoteConflictError";
	}
}

// ---------------------------------------------------------------------------
// Hashing and chunk encoding

const SHA_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 in plain JS: crypto.subtle only exists in secure contexts, and the page also runs on http. */
export function sha256Js(data: Uint8Array): Uint8Array {
	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const len = data.length;
	const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
	padded.set(data);
	padded[len] = 0x80;
	const dv = new DataView(padded.buffer);
	dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
	dv.setUint32(padded.length - 4, (len << 3) >>> 0, false);
	const w = new Uint32Array(64);
	for (let o = 0; o < padded.length; o += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15]!, b = w[i - 2]!;
			const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
			const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [number, number, number, number, number, number, number, number];
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + SHA_K[i]! + w[i]!) >>> 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
		}
		h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
		h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
	}
	const out = new Uint8Array(32);
	const odv = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]!, false);
	return out;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (subtle) return hex(new Uint8Array(await subtle.digest("SHA-256", data as BufferSource)));
	return hex(sha256Js(data));
}

const randomHex = (n: number): string => hex(globalThis.crypto.getRandomValues(new Uint8Array(n)));

async function pipeThrough(bytes: Uint8Array, stream: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> }): Promise<Uint8Array> {
	const w = stream.writable.getWriter();
	w.write(bytes as BufferSource).then(() => w.close()).catch(() => {});
	return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/**
 * Canonical chunk bytes: an 8-byte little-endian present mask, then the
 * present blocks in order. Block index within the chunk = bit number.
 */
export function encodeChunk(blocks: Map<number, Uint8Array>): { mask: bigint; canonical: Uint8Array } {
	let mask = 0n;
	const idx = [...blocks.keys()].sort((a, b) => a - b);
	for (const i of idx) mask |= 1n << BigInt(i);
	const out = new Uint8Array(8 + idx.length * BLOCK);
	new DataView(out.buffer).setBigUint64(0, mask, true);
	idx.forEach((i, n) => out.set(blocks.get(i)!, 8 + n * BLOCK));
	return { mask, canonical: out };
}

export function decodeCanonical(bytes: Uint8Array): Map<number, Uint8Array> {
	const mask = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
	const out = new Map<number, Uint8Array>();
	let n = 0;
	for (let i = 0; i < CHUNK_BLOCKS; i++) {
		if (!((mask >> BigInt(i)) & 1n)) continue;
		out.set(i, bytes.slice(8 + n * BLOCK, 8 + (n + 1) * BLOCK));
		n++;
	}
	if (8 + n * BLOCK !== bytes.length) throw new Error("corrupt chunk: length does not match its mask");
	return out;
}

/** What is stored remotely: one byte of encoding (0 raw, 1 gzip), then the canonical bytes. */
export async function packChunk(canonical: Uint8Array): Promise<Uint8Array> {
	let enc = 0, payload = canonical;
	if (typeof CompressionStream === "function") {
		const z = await pipeThrough(canonical, new CompressionStream("gzip"));
		if (z.length < canonical.length) { enc = 1; payload = z; }
	}
	const out = new Uint8Array(1 + payload.length);
	out[0] = enc;
	out.set(payload, 1);
	return out;
}

export async function unpackChunk(stored: Uint8Array): Promise<Uint8Array> {
	const enc = stored[0], body = stored.subarray(1);
	if (enc === 0) return body.slice();
	if (enc === 1) return pipeThrough(body, new DecompressionStream("gzip"));
	throw new Error(`unknown chunk encoding ${enc}`);
}

const maskHex = (m: bigint): string => m.toString(16).padStart(16, "0");
const parseEntry = (e: string): { hash: string; mask: bigint } => {
	const [hash, m] = e.split(":");
	return { hash: hash!, mask: BigInt("0x" + m!) };
};

const isZero = (b: Uint8Array): boolean => {
	for (let i = 0; i < b.length; i++) if (b[i]) return false;
	return true;
};

// ---------------------------------------------------------------------------
// Local sync state (which blocks are not pushed yet, what was synced last)

export interface SyncMeta {
	uid: string;
	rev: number;
	/** The last synced manifest, so an offline start knows which blocks exist remotely (and fails to read them instead of reading zeros). */
	manifest?: Manifest;
}

/** Persisted next to the local store: unpushed block numbers (write-ahead) and the last synced revision. */
export interface SyncState {
	load(): Promise<{ meta: SyncMeta | null; dirty: number[] }>;
	mark(blocks: number[]): Promise<void>;
	/** One transaction: forget these dirty marks and record the synced revision. */
	committed(blocks: number[], meta: SyncMeta): Promise<void>;
	setMeta(meta: SyncMeta | null): Promise<void>;
	clear(): Promise<void>;
	close?(): Promise<void>;
}

export class MemSyncState implements SyncState {
	meta: SyncMeta | null = null;
	dirty = new Set<number>();
	async load() { return { meta: this.meta, dirty: [...this.dirty] }; }
	async mark(blocks: number[]) { for (const b of blocks) this.dirty.add(b); }
	async committed(blocks: number[], meta: SyncMeta) { for (const b of blocks) this.dirty.delete(b); this.meta = meta; }
	async setMeta(meta: SyncMeta | null) { this.meta = meta; }
	async clear() { this.meta = null; this.dirty.clear(); }
}

/** IndexedDB: database "kwsync:<name>", stores "dirty" (block -> 1) and "meta". */
export class IdbSyncState implements SyncState {
	readonly name: string;
	#dbp: Promise<IDBDatabase> | null = null;

	constructor(name: string) {
		this.name = `kwsync:${name}`;
	}

	#open(): Promise<IDBDatabase> {
		return (this.#dbp ??= new Promise((resolve, reject) => {
			const r = indexedDB.open(this.name, 1);
			r.onupgradeneeded = () => { r.result.createObjectStore("dirty"); r.result.createObjectStore("meta"); };
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => { this.#dbp = null; reject(r.error); };
		}));
	}

	async #tx<T>(mode: IDBTransactionMode, fn: (d: IDBObjectStore, m: IDBObjectStore) => T | Promise<T>): Promise<T> {
		const db = await this.#open();
		const tx = db.transaction(["dirty", "meta"], mode, mode === "readwrite" ? { durability: "strict" } : undefined);
		const done = new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
		const r = await fn(tx.objectStore("dirty"), tx.objectStore("meta"));
		await done;
		return r;
	}

	static #req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

	load() {
		return this.#tx("readonly", async (d, m) => {
			const [meta, keys] = await Promise.all([IdbSyncState.#req(m.get("sync")), IdbSyncState.#req(d.getAllKeys())]);
			return { meta: (meta as SyncMeta | undefined) ?? null, dirty: keys as number[] };
		});
	}
	mark(blocks: number[]) { return this.#tx("readwrite", (d) => { for (const b of blocks) d.put(1, b); }); }
	committed(blocks: number[], meta: SyncMeta) {
		return this.#tx("readwrite", (d, m) => { for (const b of blocks) d.delete(b); m.put(meta, "sync"); });
	}
	setMeta(meta: SyncMeta | null) { return this.#tx("readwrite", (_d, m) => { if (meta) m.put(meta, "sync"); else m.delete("sync"); }); }
	clear() { return this.#tx("readwrite", (d, m) => { d.clear(); m.clear(); }); }
	async close() {
		const p = this.#dbp;
		this.#dbp = null;
		if (p) try { (await p).close(); } catch {}
	}
}

// ---------------------------------------------------------------------------
// The store

/**
 * Remote chunks by hash, kept on this machine. Chunks are immutable, so an
 * entry is never stale: after another browser's small change only the chunks
 * that changed are downloaded.
 */
export interface ChunkCache {
	get(hash: string): Promise<Uint8Array | null>;
	put(hash: string, stored: Uint8Array): Promise<void>;
	clear(): Promise<void>;
}

export class MemChunkCache implements ChunkCache {
	map = new Map<string, Uint8Array>();
	async get(hash: string) { return this.map.get(hash)?.slice() ?? null; }
	async put(hash: string, stored: Uint8Array) { this.map.set(hash, stored.slice()); }
	async clear() { this.map.clear(); }
}

/** IndexedDB "kwchunks:<name>": hash -> { bytes, t }; the oldest entries go when it holds more than maxEntries chunks (256 KiB each, less compressed). */
export class IdbChunkCache implements ChunkCache {
	readonly name: string;
	maxEntries: number;
	#dbp: Promise<IDBDatabase> | null = null;
	#puts = 0;

	constructor(name: string, maxEntries = 2048) {
		this.name = `kwchunks:${name}`;
		this.maxEntries = maxEntries;
	}

	#open(): Promise<IDBDatabase> {
		return (this.#dbp ??= new Promise((resolve, reject) => {
			const r = indexedDB.open(this.name, 1);
			r.onupgradeneeded = () => r.result.createObjectStore("chunks").createIndex("t", "t");
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => { this.#dbp = null; reject(r.error); };
		}));
	}

	async #run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
		const db = await this.#open();
		const tx = db.transaction("chunks", mode);
		const done = new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
		const req = fn(tx.objectStore("chunks"));
		const out = req ? await new Promise<T>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }) : undefined;
		await done;
		return out;
	}

	async get(hash: string): Promise<Uint8Array | null> {
		const v = (await this.#run("readonly", (s) => s.get(hash))) as { bytes: Uint8Array } | undefined;
		return v?.bytes ?? null;
	}

	async put(hash: string, stored: Uint8Array): Promise<void> {
		await this.#run("readwrite", (s) => s.put({ bytes: stored, t: Date.now() }, hash));
		if (++this.#puts % 16 === 0) await this.#trim().catch(() => {});
	}

	async #trim(): Promise<void> {
		const db = await this.#open();
		const tx = db.transaction("chunks", "readwrite");
		const done = new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
		const s = tx.objectStore("chunks");
		const count = await new Promise<number>((res, rej) => { const r = s.count(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
		let excess = count - this.maxEntries;
		if (excess > 0) {
			const cur = s.index("t").openKeyCursor();
			cur.onsuccess = () => {
				const c = cur.result;
				if (c && excess-- > 0) { s.delete(c.primaryKey); c.continue(); }
			};
		}
		await done;
	}

	async clear(): Promise<void> {
		await this.#run("readwrite", (s) => s.clear());
	}

	async close(): Promise<void> {
		const p = this.#dbp;
		this.#dbp = null;
		if (p) try { (await p).close(); } catch {}
	}
}

/** The local store a RemoteStore sits on (IdbStore, or a fake in tests). */
export interface LocalStore extends OverlayStore {
	seed(entries: Iterable<[number, Uint8Array]>, identity: string): Promise<string>;
}

export interface RemoteStatus {
	state: "synced" | "pending" | "syncing" | "offline" | "lost" | "readonly";
	dirtyBlocks: number;
	rev: number;
	error?: string;
}

export interface RemoteStoreOptions {
	/** Lease time to live; renewed every third of it. Default 3 minutes (background tabs throttle timers). */
	leaseMs?: number;
	/** Take the lease from another browser even if it is still valid. */
	steal?: boolean;
	/** Push this long after the last write (default 5 s); 0 = only syncNow(). */
	syncDelayMs?: number;
	/** Push at the latest this long after the first unpushed write (default 30 s). */
	syncMaxWaitMs?: number;
	/** The remote has moved on and this browser has unpushed changes: "fail" (default) or "remote" (drop the local changes). */
	onConflict?: "fail" | "remote";
	/** Also reset the remote (new history) on clear(). Default false: only the local copy goes. */
	resetRemote?: boolean;
	onStatus?: (s: RemoteStatus) => void;
	log?: (msg: string) => void;
	owner?: string;
	/** Remote chunks kept on this machine, so a chunk is downloaded once (IdbChunkCache in the page). */
	cache?: ChunkCache;
}

export class RemoteStore implements OverlayStore {
	readonly name: string;
	readonly owner: string;
	local: LocalStore;
	backend: RemoteBackend;
	sync: SyncState;
	opts: Required<Pick<RemoteStoreOptions, "leaseMs" | "steal" | "syncDelayMs" | "syncMaxWaitMs" | "onConflict" | "resetRemote">>;
	log: (msg: string) => void;
	onStatus: ((s: RemoteStatus) => void) | null;
	cache: ChunkCache | null;

	manifest: Manifest | null = null;
	etag: string | null = null;
	/** chunk index -> present mask of the committed remote state. */
	masks = new Map<number, bigint>();
	/** block -> sequence number of its newest unpushed write. */
	dirty = new Map<number, number>();
	state: RemoteStatus["state"] = "synced";
	canWrite = false;
	leased = false;
	lost = false;
	gen = 0;
	uid = "";
	identity = "";

	#seq = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#firstDirtyAt = 0;
	#hb: ReturnType<typeof setInterval> | null = null;
	#pushing: Promise<void> = Promise.resolve();
	#cache = new Map<string, Map<number, Uint8Array>>();
	#inflight = new Map<string, Promise<Map<number, Uint8Array>>>();
	#retry = 0;

	constructor(local: LocalStore, backend: RemoteBackend, sync: SyncState, o: RemoteStoreOptions = {}) {
		this.local = local;
		this.backend = backend;
		this.sync = sync;
		this.name = `remote:${local.name ?? "disk"}`;
		this.owner = o.owner ?? randomHex(8);
		this.opts = {
			leaseMs: o.leaseMs ?? 60_000, steal: o.steal ?? false, syncDelayMs: o.syncDelayMs ?? 5000,
			syncMaxWaitMs: o.syncMaxWaitMs ?? 30_000, onConflict: o.onConflict ?? "fail", resetRemote: o.resetRemote ?? false,
		};
		this.log = o.log ?? ((m) => console.warn(m));
		this.onStatus = o.onStatus ?? null;
		this.cache = o.cache ?? null;
	}

	#setState(state: RemoteStatus["state"], error?: string): void {
		this.state = state;
		try { this.onStatus?.({ state, dirtyBlocks: this.dirty.size, rev: this.manifest?.rev ?? 0, error }); } catch {}
	}

	#adoptManifest(m: Manifest | null, etag: string | null): void {
		this.manifest = m;
		this.etag = etag;
		this.masks.clear();
		if (m) for (const [i, e] of Object.entries(m.chunks)) this.masks.set(Number(i), parseEntry(e).mask);
	}

	#remoteHas(b: number): boolean {
		const m = this.masks.get(Math.floor(b / CHUNK_BLOCKS));
		return m !== undefined && ((m >> BigInt(b % CHUNK_BLOCKS)) & 1n) === 1n;
	}

	// --- OverlayStore ----------------------------------------------------------

	async open(identity: string, o: { onMismatch?: "clear" | "refuse"; write?: boolean } = {}): Promise<StoreIndex> {
		const write = o.write ?? true;
		this.identity = identity;
		this.canWrite = write;
		let st = await this.local.open(identity, o);
		if (st.mismatch !== undefined) return st;
		const { meta, dirty } = await this.sync.load();
		for (const b of dirty) this.dirty.set(b, ++this.#seq);

		let online = true;
		let got: { manifest: Manifest; etag: string } | null = null;
		try {
			if (write) {
				const r = await this.backend.acquireLease(this.owner, this.opts.leaseMs, this.opts.steal);
				if (!r.ok) throw new RemoteLeaseError(r.owner, r.until);
				this.leased = true;
			}
			got = await this.backend.getManifest();
		} catch (e) {
			if ((e as Error).name === "RemoteLeaseError") throw e;
			online = false;
			this.log(`[remote] ${this.name}: offline, using the local copy (${(e as Error).message})`);
		}

		let adopted = false;
		if (online) {
			if (got) {
				const m = got.manifest;
				if (m.identity !== identity) {
					await this.#release();
					return { keys: new Set(), initialized: m.seeded, mismatch: m.identity };
				}
				const inSync = meta !== null && meta.uid === m.uid && meta.rev === m.rev;
				if (!inSync && m.seeded) {
					if (this.dirty.size && this.opts.onConflict !== "remote") {
						await this.#release();
						throw new RemoteConflictError(`this browser has ${this.dirty.size} unsynced blocks, but the remote disk changed (rev ${m.rev}, this browser last synced ${meta?.rev ?? "never"})`);
					}
					if (this.dirty.size) this.log(`[remote] ${this.name}: dropping ${this.dirty.size} unsynced local blocks for the newer remote disk`);
					await this.local.clear();
					st = await this.local.open(identity, { onMismatch: "clear", write: true });
					this.dirty.clear();
					await this.sync.clear();
					adopted = true;
				} else if (!m.seeded && st.initialized && !meta) {
					for (const b of st.keys) this.dirty.set(b, ++this.#seq);
					await this.sync.mark([...st.keys]);
				}
				this.#adoptManifest(m, got.etag);
				this.uid = m.uid;
				await this.sync.setMeta({ uid: m.uid, rev: m.rev, manifest: m });
			} else {
				// No remote yet: everything local is unpushed.
				this.#adoptManifest(null, null);
				this.uid = st.uid ?? randomHex(16);
				if (st.initialized && !meta) {
					for (const b of st.keys) this.dirty.set(b, ++this.#seq);
					await this.sync.mark([...st.keys]);
				}
			}
		} else {
			// Offline: the last synced manifest says which blocks live remotely; their reads fail until the network is back.
			this.#adoptManifest(meta?.manifest ?? null, null);
			this.uid = meta?.uid ?? st.uid ?? randomHex(16);
		}

		this.#localKeys = new Set(st.keys);
		const keys = new Set(st.keys);
		for (const [idx, mask] of this.masks) for (let i = 0; i < CHUNK_BLOCKS; i++) if ((mask >> BigInt(i)) & 1n) keys.add(idx * CHUNK_BLOCKS + i);
		this.gen = adopted ? (this.manifest?.gen ?? 0) : Math.max(st.gen ?? 0, this.manifest?.gen ?? 0);

		if (write && this.leased) this.#startHeartbeat();
		this.#setState(!write ? "readonly" : !online ? "offline" : this.dirty.size ? "pending" : "synced");
		if (write && this.dirty.size) this.#schedule();
		return { keys, initialized: st.initialized || !!this.manifest?.seeded || adopted, gen: this.gen, uid: this.uid };
	}

	async getBlocks(blocks: number[]): Promise<Map<number, Uint8Array>> {
		// Blocks that only exist remotely are not looked up in IndexedDB first (a miss per read is slow).
		const localWanted = blocks.filter((b) => this.#localKeys.has(b) || !this.#remoteHas(b));
		const out = localWanted.length ? await this.local.getBlocks(localWanted) : new Map<number, Uint8Array>();
		const byChunk = new Map<number, number[]>();
		for (const b of blocks) {
			if (out.has(b) || !this.#remoteHas(b)) continue;
			const idx = Math.floor(b / CHUNK_BLOCKS);
			(byChunk.get(idx) ?? byChunk.set(idx, []).get(idx)!).push(b);
		}
		await Promise.all([...byChunk].map(async ([idx, list]) => {
			const c = await this.#chunk(idx);
			for (const b of list) { const d = c.get(b % CHUNK_BLOCKS); if (d) out.set(b, d); }
		}));
		return out;
	}

	async save(puts: Array<[number, Uint8Array]>, dels: number[] = [], meta?: { gen: number }): Promise<void> {
		const blocks = [...puts.map((p) => p[0]), ...dels];
		for (const b of blocks) { this.dirty.set(b, ++this.#seq); this.#localKeys.add(b); }
		if (this.canWrite && blocks.length) await this.sync.mark(blocks); // write-ahead: a mark without data is harmless
		// A deleted block stays as an empty record (zeros) so a stale remote copy cannot show through.
		await this.local.save([...puts, ...dels.map((b): [number, Uint8Array] => [b, new Uint8Array(0)])], [], meta);
		if (meta) this.gen = Math.max(this.gen, meta.gen);
		if (this.canWrite && !this.lost) {
			if (this.state === "synced") this.#setState("pending");
			this.#schedule();
		}
	}

	async seed(entries: Iterable<[number, Uint8Array]>, identity: string): Promise<string> {
		const list = [...entries];
		const uid = await this.local.seed(list, identity);
		this.#localKeys = new Set(list.map((e) => e[0]));
		for (const [b] of list) this.dirty.set(b, ++this.#seq);
		await this.sync.mark(list.map((e) => e[0]));
		this.#schedule();
		return this.uid || uid;
	}

	async clear(): Promise<void> {
		this.#stopTimers();
		await this.local.clear();
		await this.sync.clear();
		await this.cache?.clear().catch(() => {});
		this.dirty.clear();
		if (this.opts.resetRemote && this.leased) {
			const fresh: Manifest = { v: 1, rev: (this.manifest?.rev ?? 0) + 1, uid: randomHex(16), identity: this.identity, chunks: {}, gen: 0, seeded: false, updatedAt: Date.now() };
			const r = await this.backend.putManifest(fresh, this.etag, this.owner);
			if (typeof r === "string") throw new RemoteConflictError(`cannot reset the remote disk: ${r}`);
		}
		this.#adoptManifest(null, null);
	}

	/**
	 * For pagehide (synchronous start, the request outlives the page): give the
	 * lease back so another browser can open the disk at once, but only if
	 * everything is pushed. With unpushed changes the lease is kept (it
	 * expires by itself): letting another browser write now would make this
	 * one's changes a conflict later.
	 */
	releaseIfClean(): boolean {
		if (!this.leased) return false;
		if (this.dirty.size) {
			// Unpushed: keep the lease, but shorten it, so it is gone in seconds if the tab is really closed
			// (a reload, or a page restored from the back/forward cache, renews it at once).
			void this.backend.acquireLease(this.owner, 15_000, false).catch(() => {});
			return false;
		}
		this.#stopTimers();
		this.leased = false;
		void this.backend.releaseLease(this.owner).catch(() => {});
		return true;
	}

	async close(): Promise<void> {
		this.#stopTimers();
		if (this.canWrite && !this.lost && this.dirty.size) await this.syncNow().catch(() => {});
		await this.#release();
		await this.local.close?.();
		await this.sync.close?.();
	}

	// --- sync -------------------------------------------------------------------

	/** Push everything written so far; resolves when the remote has it (rejects if it cannot). */
	syncNow(): Promise<void> {
		const p = this.#pushing.catch(() => {}).then(() => this.#push());
		this.#pushing = p;
		return p;
	}

	#schedule(): void {
		if (this.opts.syncDelayMs <= 0 || !this.canWrite || this.lost) return;
		const now = Date.now();
		if (!this.#firstDirtyAt) this.#firstDirtyAt = now;
		const wait = Math.max(0, Math.min(this.opts.syncDelayMs, this.#firstDirtyAt + this.opts.syncMaxWaitMs - now));
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => { this.#timer = null; this.syncNow().catch(() => {}); }, wait);
	}

	#startHeartbeat(): void {
		if (this.#hb) return;
		this.#hb = setInterval(async () => {
			try {
				const r = await this.backend.acquireLease(this.owner, this.opts.leaseMs, false);
				if (!r.ok) this.#lose(`the disk was taken over by another browser (${r.owner})`);
			} catch { /* offline: the lease may expire; the next push finds out */ }
		}, Math.max(1000, this.opts.leaseMs / 3));
		(this.#hb as { unref?: () => void }).unref?.();
	}

	#stopTimers(): void {
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#hb) clearInterval(this.#hb);
		this.#timer = null;
		this.#hb = null;
	}

	async #release(): Promise<void> {
		if (!this.leased) return;
		this.leased = false;
		try { await this.backend.releaseLease(this.owner); } catch {}
	}

	#lose(why: string): void {
		if (this.lost) return;
		this.lost = true;
		this.#stopTimers();
		this.log(`[remote] ${this.name}: sync stopped: ${why}. Changes are kept locally only.`);
		this.#setState("lost", why);
	}

	async #push(): Promise<void> {
		if (!this.canWrite || this.lost || this.dirty.size === 0) return;
		this.#setState("syncing");
		try {
			if (!this.leased) await this.#reattach();
			if (this.lost) return;

			const snap = new Map(this.dirty);
			const list = [...snap.keys()];
			const recs = await this.local.getBlocks(list); // one transaction: the state after a complete flush

			const touched = new Map<number, number[]>();
			for (const b of list) (touched.get(Math.floor(b / CHUNK_BLOCKS)) ?? touched.set(Math.floor(b / CHUNK_BLOCKS), []).get(Math.floor(b / CHUNK_BLOCKS))!).push(b);

			const chunks: Record<string, string> = { ...(this.manifest?.chunks ?? {}) };
			const uploads: Array<{ hash: string; stored: Promise<Uint8Array>; bytes?: Uint8Array; decoded: Map<number, Uint8Array>; idx: number }> = [];
			for (const [idx, bl] of touched) {
				const cur = this.masks.has(idx) ? await this.#chunk(idx) : new Map<number, Uint8Array>();
				const next = new Map(cur);
				let changed = false;
				for (const b of bl) {
					const rec = recs.get(b);
					if (rec === undefined) continue; // marked but never saved: nothing to push
					const i = b % CHUNK_BLOCKS;
					if (!rec.length || isZero(rec)) { changed = next.delete(i) || changed; continue; }
					const old = cur.get(i);
					if (!old || old.length !== rec.length || old.some((v, k) => v !== rec[k])) { next.set(i, rec.slice()); changed = true; }
				}
				if (!changed) continue;
				if (next.size === 0) { delete chunks[idx]; continue; }
				const { mask, canonical } = encodeChunk(next);
				const hash = await sha256Hex(canonical);
				chunks[idx] = `${hash}:${maskHex(mask)}`;
				uploads.push({ hash, stored: packChunk(canonical), decoded: next, idx });
			}

			// Chunks first (immutable, harmless if the manifest never lands), then the manifest.
			const queue = [...uploads];
			await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
				for (let u = queue.shift(); u; u = queue.shift()) { u.bytes = await u.stored; await this.backend.putChunk(u.hash, u.bytes); }
			}));

			const prev = this.manifest;
			const m2: Manifest = {
				v: 1, rev: (prev?.rev ?? 0) + 1, uid: this.uid, identity: this.identity, chunks,
				gen: this.gen, seeded: true, updatedAt: Date.now(),
			};
			const res = await this.backend.putManifest(m2, this.etag, this.owner);
			if (res === "conflict") return this.#lose("the remote disk changed (another browser pushed)");
			if (res === "lease") return this.#lose("the lease was lost");

			this.#adoptManifest(m2, res.etag);
			for (const u of uploads) {
				this.#remember(u.hash, u.decoded);
				if (u.bytes) void this.cache?.put(u.hash, u.bytes).catch(() => {});
			}
			const clean: number[] = [];
			for (const [b, s] of snap) if (this.dirty.get(b) === s) { this.dirty.delete(b); clean.push(b); }
			await this.sync.committed(clean, { uid: m2.uid, rev: m2.rev, manifest: m2 });
			this.#retry = 0;
			this.#firstDirtyAt = 0;
			this.log(`[remote] ${this.name}: pushed rev ${m2.rev}: ${uploads.length} chunks, ${list.length} blocks`);
			this.#setState(this.dirty.size ? "pending" : "synced");
			if (this.dirty.size) this.#schedule();
		} catch (e) {
			const err = e as Error;
			this.log(`[remote] ${this.name}: sync failed: ${err.name}: ${err.message}`);
			this.#setState("offline", err.message);
			// Retry with backoff; the data is safe locally.
			if (this.opts.syncDelayMs > 0 && !this.lost) {
				const wait = Math.min(120_000, 2000 * 2 ** this.#retry++);
				if (this.#timer) clearTimeout(this.#timer);
				this.#timer = setTimeout(() => { this.#timer = null; this.syncNow().catch(() => {}); }, wait);
			}
			throw e;
		}
	}

	/** After an offline start (or a lost connection): take the lease and check the remote did not move on. */
	async #reattach(): Promise<void> {
		const r = await this.backend.acquireLease(this.owner, this.opts.leaseMs, this.opts.steal);
		if (!r.ok) return this.#lose(`the disk is open in another browser (${r.owner})`);
		this.leased = true;
		const got = await this.backend.getManifest();
		const known = this.manifest;
		if (got && (!known || got.manifest.rev !== known.rev || got.manifest.uid !== known.uid)) {
			if (!(known === null && got.manifest.seeded === false)) return this.#lose(`the remote disk changed while this browser was offline (rev ${got.manifest.rev})`);
		}
		if (got) this.#adoptManifest(got.manifest, got.etag);
		this.#startHeartbeat();
	}

	// --- remote chunks ----------------------------------------------------------

	#localKeys = new Set<number>();

	/** Warm the chunk cache in the background (a few at a time, at most `max` chunks) so later reads are memory hits. */
	prefetch(max = 192, concurrency = 4): Promise<void> {
		const idxs = [...this.masks.keys()].filter((i) => !this.#cache.has(parseEntry(this.manifest!.chunks[i]!).hash)).slice(0, max);
		let n = 0;
		const worker = async () => { while (n < idxs.length) { const i = idxs[n++]!; try { await this.#chunk(i); } catch { /* read errors surface on use */ } } };
		return Promise.all(Array.from({ length: concurrency }, worker)).then(() => {});
	}

	#remember(hash: string, blocks: Map<number, Uint8Array>): void {
		this.#cache.delete(hash);
		this.#cache.set(hash, blocks);
		while (this.#cache.size > 256) this.#cache.delete(this.#cache.keys().next().value!);
	}

	#chunk(idx: number): Promise<Map<number, Uint8Array>> {
		const e = this.manifest?.chunks[idx];
		if (!e) return Promise.resolve(new Map());
		const { hash } = parseEntry(e);
		const hit = this.#cache.get(hash);
		if (hit) return Promise.resolve(hit);
		let p = this.#inflight.get(hash);
		if (!p) {
			p = (async () => {
				const want = 8 + popcount(parseEntry(e).mask) * BLOCK;
				let blocks: Map<number, Uint8Array> | null = null;
				const cached = await this.cache?.get(hash).catch(() => null);
				if (cached) {
					try {
						const canonical = await unpackChunk(cached);
						if (canonical.length === want) blocks = decodeCanonical(canonical);
					} catch { /* a damaged cache entry: fetch it again */ }
				}
				if (!blocks) {
					const stored = await this.backend.getChunk(hash);
					const canonical = await unpackChunk(stored);
					if (canonical.length !== want || (await sha256Hex(canonical)) !== hash) throw new Error(`chunk ${hash} is corrupt`);
					blocks = decodeCanonical(canonical);
					void this.cache?.put(hash, stored).catch(() => {});
				}
				this.#remember(hash, blocks);
				return blocks;
			})().finally(() => this.#inflight.delete(hash));
			this.#inflight.set(hash, p);
		}
		return p;
	}
}

function popcount(m: bigint): number {
	let n = 0;
	for (; m; m >>= 1n) n += Number(m & 1n);
	return n;
}

// ---------------------------------------------------------------------------
// HTTP backend: the REST API of web/scripts/disk-server.ts and the Cloudflare Worker.
//
//   GET    <base>/manifest            200 + ETag, or 404
//   PUT    <base>/manifest            If-Match: <etag> | If-None-Match: *   X-Owner  -> 200 + ETag | 412 | 423
//   POST   <base>/lease               {owner, ttlMs, steal}                 -> 200 {ok,until} | 200 {ok:false,owner,until}
//   DELETE <base>/lease?owner=        release
//   GET    <base>/chunks/<sha256>     immutable
//   PUT    <base>/chunks/<sha256>     idempotent

export interface HttpBackendOptions {
	/** e.g. https://disks.example.com/disks/my-disk */
	url: string;
	token?: string;
	fetch?: typeof fetch;
}

export class HttpBackend implements RemoteBackend {
	base: string;
	token?: string;
	#fetch: typeof fetch;

	constructor({ url, token, fetch: f }: HttpBackendOptions) {
		this.base = url.replace(/\/+$/, "");
		this.token = token;
		this.#fetch = f ?? ((...a) => fetch(...a));
	}

	#headers(extra: Record<string, string> = {}): Record<string, string> {
		return this.token ? { authorization: `Bearer ${this.token}`, ...extra } : extra;
	}

	async getManifest() {
		const r = await this.#fetch(`${this.base}/manifest`, { headers: this.#headers(), cache: "no-store" });
		if (r.status === 404) return null;
		if (!r.ok) throw new Error(`GET manifest: HTTP ${r.status}`);
		return { manifest: (await r.json()) as Manifest, etag: r.headers.get("etag") ?? "" };
	}

	async putManifest(m: Manifest, ifMatch: string | null, owner: string): Promise<PutManifestResult> {
		const r = await this.#fetch(`${this.base}/manifest`, {
			method: "PUT",
			headers: this.#headers({ "content-type": "application/json", "x-owner": owner, ...(ifMatch === null ? { "if-none-match": "*" } : { "if-match": ifMatch }) }),
			body: JSON.stringify(m),
		});
		if (r.status === 412) return "conflict";
		if (r.status === 423) return "lease";
		if (!r.ok) throw new Error(`PUT manifest: HTTP ${r.status}`);
		return { etag: r.headers.get("etag") ?? "" };
	}

	async acquireLease(owner: string, ttlMs: number, steal = false): Promise<LeaseResult> {
		const r = await this.#fetch(`${this.base}/lease`, {
			method: "POST", headers: this.#headers({ "content-type": "application/json" }), body: JSON.stringify({ owner, ttlMs, steal }), keepalive: true,
		});
		if (!r.ok) throw new Error(`POST lease: HTTP ${r.status}`);
		return (await r.json()) as LeaseResult;
	}

	async releaseLease(owner: string): Promise<void> {
		await this.#fetch(`${this.base}/lease?owner=${encodeURIComponent(owner)}`, { method: "DELETE", headers: this.#headers(), keepalive: true });
	}

	async getChunk(hash: string): Promise<Uint8Array> {
		const r = await this.#fetch(`${this.base}/chunks/${hash}`, { headers: this.#headers() });
		if (!r.ok) throw new Error(`GET chunk ${hash}: HTTP ${r.status}`);
		return new Uint8Array(await r.arrayBuffer());
	}

	async putChunk(hash: string, data: Uint8Array): Promise<void> {
		const r = await this.#fetch(`${this.base}/chunks/${hash}`, { method: "PUT", headers: this.#headers({ "content-type": "application/octet-stream" }), body: data as BodyInit });
		if (!r.ok) throw new Error(`PUT chunk ${hash}: HTTP ${r.status}`);
	}
}

/** An in-memory backend with the server's semantics (lease + CAS); for tests and as the reference for servers. */
export class MemBackend implements RemoteBackend {
	manifest: Manifest | null = null;
	rev = 0;
	chunks = new Map<string, Uint8Array>();
	lease: { owner: string; until: number } | null = null;
	now = () => Date.now();
	down = false;
	puts = 0;
	gets = 0;

	#check() { if (this.down) throw new Error("backend down"); }
	async getManifest() {
		this.#check();
		return this.manifest ? { manifest: structuredClone(this.manifest), etag: String(this.manifest.rev) } : null;
	}
	async putManifest(m: Manifest, ifMatch: string | null, owner: string): Promise<PutManifestResult> {
		this.#check();
		if (!this.lease || this.lease.owner !== owner || this.lease.until < this.now()) return "lease";
		if ((ifMatch === null) !== (this.manifest === null) || (this.manifest && ifMatch !== String(this.manifest.rev))) return "conflict";
		this.manifest = structuredClone(m);
		return { etag: String(m.rev) };
	}
	async acquireLease(owner: string, ttlMs: number, steal = false): Promise<LeaseResult> {
		this.#check();
		const l = this.lease;
		if (l && l.owner !== owner && l.until > this.now() && !steal) return { ok: false, owner: l.owner, until: l.until };
		this.lease = { owner, until: this.now() + ttlMs };
		return { ok: true, until: this.lease.until };
	}
	async releaseLease(owner: string) {
		if (this.lease?.owner === owner) this.lease = null;
	}
	async getChunk(hash: string) {
		this.#check();
		this.gets++;
		const c = this.chunks.get(hash);
		if (!c) throw new Error(`no chunk ${hash}`);
		return c.slice();
	}
	async putChunk(hash: string, data: Uint8Array) {
		this.#check();
		this.puts++;
		this.chunks.set(hash, data.slice());
	}
}

export { CHUNK_BYTES };
