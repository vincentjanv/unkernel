// SPDX-License-Identifier: MIT
// The two-browser scenario against any running disk server (the file server
// or the Cloudflare Worker under `wrangler dev`). Skipped without DISK_URL.
//
//   DISK_URL=http://127.0.0.1:8787 DISK_TOKEN=secret node --test test/remote-disk-live.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { CowDisk, ZeroBase } from "../js/core/block.ts";
import { HttpBackend, MemSyncState, RemoteConflictError, RemoteLeaseError, RemoteStore, type LocalStore } from "../js/web/remote-disk.ts";

const B = 4096;
const URL_ = process.env.DISK_URL, TOKEN = process.env.DISK_TOKEN;

class MemLocal implements LocalStore {
	name = "mem";
	blocks = new Map<number, Uint8Array>();
	initialized = false;
	gen = 0;
	uid = "u" + Math.random().toString(16).slice(2);
	async open() { return { keys: new Set(this.blocks.keys()), initialized: this.initialized, gen: this.gen, uid: this.uid }; }
	async getBlocks(bl: number[]) { const o = new Map<number, Uint8Array>(); for (const b of bl) { const v = this.blocks.get(b); if (v) o.set(b, v.slice()); } return o; }
	async save(puts: Array<[number, Uint8Array]>, dels: number[], meta?: { gen: number }) { for (const [b, v] of puts) this.blocks.set(b, v.slice()); for (const b of dels) this.blocks.delete(b); if (meta) this.gen = meta.gen; }
	async seed(entries: Iterable<[number, Uint8Array]>) { this.blocks = new Map([...entries].map(([b, v]) => [b, v.slice()])); this.initialized = true; return this.uid; }
	async clear() { this.blocks.clear(); this.initialized = false; this.gen = 0; }
}

const diskId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const mk = (token = TOKEN) => {
	const local = new MemLocal();
	const store = new RemoteStore(local, new HttpBackend({ url: `${URL_}/disks/${diskId}`, token }), new MemSyncState(), { syncDelayMs: 0, log: () => {} });
	return { local, store };
};
const open = async (store: RemoteStore) => { const d = new CowDisk(new ZeroBase(64 << 20), { store, log: () => {} }); await d.open(); return d; };

test("live: push, lease, adopt in a second browser, delta", { skip: !URL_ }, async () => {
	const a = mk();
	const da = await open(a.store);
	await da.write(5 * B, [new Uint8Array(B).fill(42)]);
	await da.write(9000 * B, [new Uint8Array(B).map((_, i) => i & 255)]);
	await da.flush();
	await a.store.syncNow();
	assert.equal(a.store.manifest!.rev, 1);

	await assert.rejects(open(mk().store), (e: Error) => e instanceof RemoteLeaseError, "A holds the lease");

	await da.write(5 * B, [new Uint8Array(B).fill(43)]); // one chunk changes
	await da.flush();
	await a.store.syncNow();
	assert.equal(a.store.manifest!.rev, 2);
	await a.store.close();

	const b = mk();
	const db = await open(b.store);
	const buf = new Uint8Array(B);
	await db.read(5 * B, [buf]);
	assert.equal(buf[0], 43);
	await db.read(9000 * B, [buf]);
	assert.equal(buf[255], 255);
	assert.equal(b.local.blocks.size, 0, "read lazily from the remote");
	await db.write(6 * B, [new Uint8Array(B).fill(7)]);
	await db.flush();
	await b.store.syncNow();
	assert.equal(b.store.manifest!.rev, 3);
	await b.store.close();
});

test("live: a wrong token is refused, an unknown disk id is a 404", { skip: !URL_ }, async () => {
	if (TOKEN) assert.equal((await fetch(`${URL_}/disks/${diskId}/manifest`, { headers: { authorization: "Bearer nope" } })).status, 401);
	assert.equal((await fetch(`${URL_}/disks/${diskId}/nothing`, { headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} })).status, 404);
	assert.equal((await fetch(`${URL_}/disks/${diskId}/chunks/${"b".repeat(64)}`, { method: "PUT", headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}, body: new Uint8Array([0, 9, 9]) })).status, 400, "content must hash to its name");
});

test("live: a conflict is reported, not merged", { skip: !URL_ }, async () => {
	const a = mk();
	const da = await open(a.store);
	await da.write(1 * B, [new Uint8Array(B).fill(1)]); await da.flush(); await a.store.syncNow();
	const { local, sync } = { local: a.local, sync: a.store.sync };
	await a.store.close();
	const b = mk();
	const db = await open(b.store);
	await db.write(2 * B, [new Uint8Array(B).fill(2)]); await db.flush(); await b.store.syncNow(); await b.store.close();
	// A returns with unpushed changes (it never saw rev+1).
	await local.save([[3, new Uint8Array(B).fill(3)]], []);
	await sync.mark([3]);
	const a2 = new RemoteStore(local, new HttpBackend({ url: `${URL_}/disks/${diskId}`, token: TOKEN }), sync, { syncDelayMs: 0, log: () => {} });
	await assert.rejects(open(a2), (e: Error) => e instanceof RemoteConflictError);
});
