// SPDX-License-Identifier: MIT
// Tests for the remote-synced disk (js/web/remote-disk.ts): a CowDisk on a
// RemoteStore over in-memory local stores and an in-memory backend that
// behaves like the server (lease + compare-and-swap manifest).
//
//   node --test test/remote-disk.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CowDisk, ZeroBase } from "../js/core/block.ts";
import {
	CHUNK_BLOCKS, MemBackend, MemChunkCache, MemSyncState, RemoteConflictError, RemoteLeaseError, RemoteStore, decodeCanonical, encodeChunk,
	packChunk, sha256Hex, sha256Js, unpackChunk, type LocalStore, type RemoteStoreOptions,
} from "../js/web/remote-disk.ts";

const B = 4096;
const SIZE = 64 * 1024 * 1024;

class MemLocal implements LocalStore {
	name = "mem";
	blocks = new Map<number, Uint8Array>();
	identity: string | undefined;
	initialized = false;
	gen = 0;
	uid: string | undefined;
	async open(identity: string, o: { onMismatch?: "clear" | "refuse" } = {}) {
		if (this.identity !== undefined && this.identity !== identity) {
			if (o.onMismatch !== "clear") return { keys: new Set<number>(), initialized: this.initialized, mismatch: this.identity };
			await this.clear();
		}
		this.identity = identity;
		this.uid ??= Math.random().toString(16).slice(2);
		return { keys: new Set(this.blocks.keys()), initialized: this.initialized, gen: this.gen, uid: this.uid };
	}
	async getBlocks(bl: number[]) {
		const out = new Map<number, Uint8Array>();
		for (const b of bl) { const v = this.blocks.get(b); if (v) out.set(b, v.slice()); }
		return out;
	}
	async save(puts: Array<[number, Uint8Array]>, dels: number[], meta?: { gen: number }) {
		for (const [b, v] of puts) this.blocks.set(b, v.slice());
		for (const b of dels) this.blocks.delete(b);
		if (meta) this.gen = meta.gen;
	}
	async seed(entries: Iterable<[number, Uint8Array]>, identity: string) {
		this.blocks.clear();
		for (const [b, v] of entries) this.blocks.set(b, v.slice());
		this.identity = identity; this.initialized = true; this.gen = 0;
		return (this.uid = Math.random().toString(16).slice(2));
	}
	async clear() { this.blocks.clear(); this.identity = undefined; this.initialized = false; this.gen = 0; this.uid = undefined; }
}

/** One "browser": its own local store and sync state. */
function browser(backend: MemBackend, o: RemoteStoreOptions = {}, local = new MemLocal(), sync = new MemSyncState()) {
	const store = new RemoteStore(local, backend, sync, { syncDelayMs: 0, log: () => {}, leaseMs: 60_000, ...o });
	return { local, sync, store };
}

async function openDisk(store: RemoteStore) {
	const d = new CowDisk(new ZeroBase(SIZE), { store, log: () => {} });
	await d.open();
	return d;
}

const fill = (n: number): Uint8Array => new Uint8Array(B).fill(n);
const w = (d: CowDisk, block: number, n: number) => d.write(block * B, [fill(n)]);
async function r(d: CowDisk, block: number): Promise<number[]> {
	const buf = new Uint8Array(B);
	await d.read(block * B, [buf]);
	return [buf[0]!, buf[B - 1]!];
}

test("sha256Js matches node crypto", async () => {
	for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 262152]) {
		const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
		assert.equal(Buffer.from(sha256Js(data)).toString("hex"), createHash("sha256").update(data).digest("hex"), `length ${n}`);
	}
	assert.equal(await sha256Hex(new Uint8Array([1, 2, 3])), createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"));
});

test("chunk encoding round-trips, compressed or not", async () => {
	const blocks = new Map([[0, fill(7)], [5, fill(9)], [63, new Uint8Array(B).map((_, i) => i & 255)]]);
	const { mask, canonical } = encodeChunk(blocks);
	assert.equal(mask, (1n << 0n) | (1n << 5n) | (1n << 63n));
	const back = decodeCanonical(await unpackChunk(await packChunk(canonical)));
	assert.deepEqual([...back.keys()], [0, 5, 63]);
	for (const [i, v] of blocks) assert.deepEqual(back.get(i), v);
});

test("a second browser opens the disk the first one pushed", async () => {
	const backend = new MemBackend();
	const a = browser(backend);
	const da = await openDisk(a.store);
	await w(da, 3, 11); await w(da, 1000, 22); await w(da, 1001, 33);
	await da.flush();
	await a.store.syncNow();
	assert.equal(backend.manifest!.rev, 1);
	assert.equal(Object.keys(backend.manifest!.chunks).length, 2); // blocks 3 | 1000+1001 (chunks 0 and 15)
	await a.store.close();

	const b = browser(backend);
	const db = await openDisk(b.store);
	assert.deepEqual(await r(db, 3), [11, 11]);
	assert.deepEqual(await r(db, 1000), [22, 22]);
	assert.deepEqual(await r(db, 1001), [33, 33]);
	assert.deepEqual(await r(db, 2), [0, 0]);
	assert.equal(b.local.blocks.size, 0, "reads come from the remote, nothing is copied locally");
	await b.store.close();
});

test("a push uploads only the chunks that changed (delta)", async () => {
	const backend = new MemBackend();
	const a = browser(backend);
	const d = await openDisk(a.store);
	for (let i = 0; i < 200; i++) await w(d, i, (i % 250) + 1); // 4 chunks
	await d.flush(); await a.store.syncNow();
	assert.equal(backend.puts, Math.ceil(200 / CHUNK_BLOCKS));
	backend.puts = 0;
	await w(d, 70, 99); // chunk 1 only
	await d.flush(); await a.store.syncNow();
	assert.equal(backend.puts, 1);
	assert.equal(backend.manifest!.rev, 2);
	await w(d, 70, 99); // same content again: no new chunk, no wasted upload
	await d.flush(); await a.store.syncNow();
	assert.equal(backend.puts, 1);
	await a.store.close();
});

test("deleted (zeroed) blocks stay deleted in other browsers", async () => {
	const backend = new MemBackend();
	const a = browser(backend);
	const d = await openDisk(a.store);
	await w(d, 10, 5); await w(d, 11, 6);
	await d.flush(); await a.store.syncNow();
	await d.discard(10 * B, B);
	await d.flush(); await a.store.syncNow();
	await a.store.close();
	const b = browser(backend);
	const db = await openDisk(b.store);
	assert.deepEqual(await r(db, 10), [0, 0]);
	assert.deepEqual(await r(db, 11), [6, 6]);
	await b.store.close();
});

test("the lease keeps a second writer out until it is released", async () => {
	const backend = new MemBackend();
	const a = browser(backend);
	await openDisk(a.store);
	const b = browser(backend);
	await assert.rejects(openDisk(b.store), (e: Error) => e instanceof RemoteLeaseError);
	await a.store.close(); // releases
	const b2 = browser(backend);
	await openDisk(b2.store);
	await b2.store.close();
});

test("an expired lease can be taken over, and the old owner's push is refused", async () => {
	const backend = new MemBackend();
	let t = 1000;
	backend.now = () => t;
	const a = browser(backend, { leaseMs: 10_000 });
	const da = await openDisk(a.store);
	await w(da, 1, 1); await da.flush(); await a.store.syncNow();
	t += 60_000; // A's lease expired (its heartbeat never ran in this test)
	const b = browser(backend, { leaseMs: 10_000 });
	const db = await openDisk(b.store);
	assert.deepEqual(await r(db, 1), [1, 1]);
	await w(da, 2, 2); await da.flush();
	await a.store.syncNow(); // refused: B holds the lease now
	assert.equal(a.store.state, "lost");
	assert.deepEqual(await r(da, 2), [2, 2], "A keeps working locally");
	assert.equal(backend.manifest!.rev, 1);
	await b.store.close();
});

test("a browser with unsynced changes against a newer remote reports a conflict", async () => {
	const backend = new MemBackend();
	const a = browser(backend);
	const da = await openDisk(a.store);
	await w(da, 1, 1); await da.flush(); await a.store.syncNow();
	const aLocal = a.local, aSync = a.sync;
	await a.store.close();

	// Another browser pushes a newer revision.
	const b = browser(backend);
	const db = await openDisk(b.store);
	await w(db, 2, 2); await db.flush(); await b.store.syncNow();
	await b.store.close();

	// A comes back with local changes it never pushed (offline).
	backend.down = true;
	const a2 = browser(backend, {}, aLocal, aSync);
	const da2 = await openDisk(a2.store);
	assert.equal(a2.store.state, "offline");
	await w(da2, 3, 3); await da2.flush();
	backend.down = false;
	await a2.store.close().catch(() => {});

	const a3 = browser(backend, {}, aLocal, aSync);
	await assert.rejects(openDisk(a3.store), (e: Error) => e instanceof RemoteConflictError);

	// Choosing the remote drops the local changes and adopts it.
	const a4 = browser(backend, { onConflict: "remote" }, aLocal, aSync);
	const da4 = await openDisk(a4.store);
	assert.deepEqual(await r(da4, 2), [2, 2]);
	assert.deepEqual(await r(da4, 3), [0, 0]);
	await a4.store.close();
});

test("offline start works from the local copy and pushes when the network is back", async () => {
	const backend = new MemBackend();
	const a = browser(backend);
	const da = await openDisk(a.store);
	await w(da, 4, 4); await da.flush(); await a.store.syncNow();
	await a.store.close();

	backend.down = true;
	const a2 = browser(backend, {}, a.local, a.sync);
	const d2 = await openDisk(a2.store);
	assert.deepEqual(await r(d2, 4), [4, 4]);
	await w(d2, 5, 5); await d2.flush();
	await assert.rejects(a2.store.syncNow());
	assert.equal(a2.store.dirty.size, 1);
	backend.down = false;
	await a2.store.syncNow();
	assert.equal(a2.store.dirty.size, 0);
	assert.equal(backend.manifest!.rev, 2);
	await a2.store.close();
});

test("a push is crash-consistent: the manifest only ever names complete states", async () => {
	const backend = new MemBackend();
	const a = browser(backend);
	const d = await openDisk(a.store);
	await w(d, 1, 1); await w(d, 2, 1); await d.flush();
	const failing = backend.putChunk.bind(backend);
	backend.putChunk = async () => { throw new Error("connection lost mid-upload"); };
	await assert.rejects(a.store.syncNow());
	assert.equal(backend.manifest, null, "no manifest until every chunk is up");
	backend.putChunk = failing;
	await a.store.syncNow();
	assert.equal(backend.manifest!.rev, 1);
	await a.store.close();
});

test("a browser that was behind downloads only the chunks that changed", async () => {
	const backend = new MemBackend();
	const a = browser(backend);
	const da = await openDisk(a.store);
	for (let i = 0; i < 200; i++) await w(da, i, (i % 250) + 1); // 4 chunks
	await da.flush(); await a.store.syncNow(); await a.store.close();

	const cache = new MemChunkCache();
	const bl = new MemLocal(), bs = new MemSyncState();
	const b1 = browser(backend, { cache }, bl, bs);
	const db1 = await openDisk(b1.store);
	for (let i = 0; i < 200; i++) await r(db1, i);
	assert.equal(backend.gets, 4, "first time: every chunk it reads");
	await b1.store.close();

	// Another browser changes one block; this one comes back and reads everything again.
	const a2 = browser(backend, {}, a.local, a.sync);
	const da2 = await openDisk(a2.store);
	await w(da2, 70, 99); await da2.flush(); await a2.store.syncNow(); await a2.store.close();

	backend.gets = 0;
	const b2 = browser(backend, { cache }, bl, bs);
	const db2 = await openDisk(b2.store);
	for (let i = 0; i < 200; i++) await r(db2, i);
	assert.equal(backend.gets, 1, "one changed chunk; the other three come from the local cache");
	assert.deepEqual(await r(db2, 70), [99, 99]);
	await b2.store.close();
});
