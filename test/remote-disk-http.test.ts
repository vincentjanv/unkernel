// SPDX-License-Identifier: MIT
// End to end: two "browsers" (RemoteStore over in-memory local stores) sync
// through HttpBackend and the file-based disk server (web/scripts/disk-server.ts).
//
//   node --test test/remote-disk-http.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CowDisk, ZeroBase } from "../js/core/block.ts";
import { HttpBackend, MemSyncState, RemoteLeaseError, RemoteStore, type LocalStore } from "../js/web/remote-disk.ts";
import { createDiskServer } from "../web/scripts/disk-server.ts";

const B = 4096;

class MemLocal implements LocalStore {
	name = "mem";
	blocks = new Map<number, Uint8Array>();
	identity: string | undefined;
	initialized = false;
	gen = 0;
	uid = "u" + Math.random().toString(16).slice(2);
	async open(identity: string) { this.identity = identity; return { keys: new Set(this.blocks.keys()), initialized: this.initialized, gen: this.gen, uid: this.uid }; }
	async getBlocks(bl: number[]) { const o = new Map<number, Uint8Array>(); for (const b of bl) { const v = this.blocks.get(b); if (v) o.set(b, v.slice()); } return o; }
	async save(puts: Array<[number, Uint8Array]>, dels: number[], meta?: { gen: number }) { for (const [b, v] of puts) this.blocks.set(b, v.slice()); for (const b of dels) this.blocks.delete(b); if (meta) this.gen = meta.gen; }
	async seed(entries: Iterable<[number, Uint8Array]>, identity: string) { this.blocks = new Map([...entries].map(([b, v]) => [b, v.slice()])); this.identity = identity; this.initialized = true; return this.uid; }
	async clear() { this.blocks.clear(); this.initialized = false; this.gen = 0; }
}

async function withServer(token: string | undefined, fn: (url: string, dir: string) => Promise<void>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kwdisk-"));
	const server = createDiskServer({ dir, token });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir); }
	finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const mk = (url: string, token?: string) => {
	const local = new MemLocal();
	const store = new RemoteStore(local, new HttpBackend({ url: `${url}/disks/my-disk`, token }), new MemSyncState(), { syncDelayMs: 0, log: () => {} });
	return { local, store };
};
const open = async (store: RemoteStore) => { const d = new CowDisk(new ZeroBase(64 << 20), { store, log: () => {} }); await d.open(); return d; };

test("two browsers share a disk through the file server", async () => {
	await withServer("s3cret", async (url, dir) => {
		const a = mk(url, "s3cret");
		const da = await open(a.store);
		await da.write(5 * B, [new Uint8Array(B).fill(42)]);
		await da.write(9000 * B, [new Uint8Array(B).map((_, i) => i & 255)]);
		await da.flush();
		await a.store.syncNow();
		assert.equal(a.store.manifest!.rev, 1);

		// While A holds the lease, B cannot write.
		const b0 = mk(url, "s3cret");
		await assert.rejects(open(b0.store), (e: Error) => e instanceof RemoteLeaseError);
		await a.store.close();

		const b = mk(url, "s3cret");
		const db = await open(b.store);
		const buf = new Uint8Array(B);
		await db.read(5 * B, [buf]);
		assert.equal(buf[0], 42);
		await db.read(9000 * B, [buf]);
		assert.equal(buf[255], 255);
		assert.equal(buf[256], 0);
		await db.write(6 * B, [new Uint8Array(B).fill(7)]);
		await db.flush();
		await b.store.syncNow();
		assert.equal(b.store.manifest!.rev, 2);
		await b.store.close();

		const files = fs.readdirSync(path.join(dir, "my-disk", "chunks"));
		assert.ok(files.length >= 3 && files.every((f) => /^[0-9a-f]{64}$/.test(f)), "chunks are stored under their hash");
	});
});

test("the server enforces auth, validates chunks and refuses a manifest naming a missing chunk", async () => {
	await withServer("tok", async (url) => {
		const base = `${url}/disks/d1`;
		assert.equal((await fetch(`${base}/manifest`)).status, 401);
		const h = { authorization: "Bearer tok" };
		assert.equal((await fetch(`${base}/manifest`, { headers: h })).status, 404);
		const bad = "a".repeat(64);
		assert.equal((await fetch(`${base}/chunks/${bad}`, { method: "PUT", headers: h, body: new Uint8Array([0, 1, 2]) })).status, 400, "content must hash to its name");
		assert.equal((await fetch(`${url}/disks/..%2f..%2fetc/manifest`, { headers: h })).status, 404, "no path traversal");

		const owner = "ab".repeat(8);
		await fetch(`${base}/lease`, { method: "POST", headers: h, body: JSON.stringify({ owner, ttlMs: 60000 }) });
		const mf = { v: 1, rev: 1, uid: "x", identity: "i", chunks: { "0": `${bad}:${"0".repeat(15)}1` }, gen: 0, seeded: true, updatedAt: 0 };
		const put = (o: string) => fetch(`${base}/manifest`, { method: "PUT", headers: { ...h, "x-owner": o, "if-none-match": "*" }, body: JSON.stringify(mf) });
		assert.equal((await put("cd".repeat(8))).status, 423, "only the lease holder may write");
		assert.equal((await put(owner)).status, 400, "missing chunk");
	});
});
