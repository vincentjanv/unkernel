// SPDX-License-Identifier: MIT
// openDataDisk({ remote }) with the real IdbStore and IdbSyncState over
// fake-indexeddb (one IDBFactory per "browser"), against the file server.
// Skipped when fake-indexeddb is not installed.
//
//   npm i --no-save fake-indexeddb && node --test test/remote-disk-idb.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { encodeKwsparse } from "../js/core/kwsparse.ts";
import { RemoteStore } from "../js/web/remote-disk.ts";
import { openDataDisk } from "../js/web/disk.ts";
import { createDiskServer } from "../web/scripts/disk-server.ts";

let fake: typeof import("fake-indexeddb") | null = null;
try {
	fake = await import("fake-indexeddb");
	(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fake.IDBKeyRange;
} catch { /* skipped below */ }

const B = 4096;
const SIZE = 32 * 1024 * 1024;
const template = encodeKwsparse({ size: SIZE, blocks: [[0, new Uint8Array(B).fill(1)], [1, new Uint8Array(B).fill(2)]] });

/** Run fn as one "browser": its own IndexedDB. */
async function inBrowser<T>(idb: IDBFactory, fn: () => Promise<T>): Promise<T> {
	(globalThis as { indexedDB: IDBFactory }).indexedDB = idb;
	return fn();
}

const rd = async (d: { read(off: number, v: Uint8Array[]): unknown }, b: number) => { const x = new Uint8Array(B); await d.read(b * B, [x]); return x[0]; };

test("data disk: seeded in browser A, adopted by browser B, B's change adopted back by A", { skip: !fake }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kwdisk-idb-"));
	const server = createDiskServer({ dir });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/disks/home`;
	const opts = { url, options: { syncDelayMs: 0, log: () => {} } };
	const log = () => {};
	const A = new fake!.IDBFactory(), Bf = new fake!.IDBFactory();
	try {
		// A: first ever open seeds from the template and pushes it.
		await inBrowser(A, async () => {
			const d = await openDataDisk({ template, log, remote: opts });
			assert.equal(d.seeded, true);
			const rs = d.store as RemoteStore;
			assert.ok(rs instanceof RemoteStore);
			await d.write(7 * B, [new Uint8Array(B).fill(77)]);
			await d.flush();
			await rs.syncNow();
			assert.equal(rs.manifest!.rev, 1);
			assert.equal(rs.dirty.size, 0);
			await rs.close();
		});

		// B: an empty browser gets A's disk (not the template), reads lazily, changes and deletes things.
		await inBrowser(Bf, async () => {
			const d = await openDataDisk({ template, log, remote: opts });
			assert.equal(d.seeded, false, "adopted the remote disk, did not seed");
			assert.equal(await rd(d, 0), 1);
			assert.equal(await rd(d, 7), 77);
			await d.write(8 * B, [new Uint8Array(B).fill(88)]);
			await d.discard(0, B); // block 0 becomes zeros
			await d.flush();
			const rs = d.store as RemoteStore;
			await rs.syncNow();
			assert.equal(rs.manifest!.rev, 2);
			await rs.close();
		});

		// A again: nothing unpushed, the remote moved on: adopt it (including the deletion).
		await inBrowser(A, async () => {
			const d = await openDataDisk({ template, log, remote: opts });
			assert.equal(await rd(d, 8), 88);
			assert.equal(await rd(d, 0), 0, "the deletion made in B shows in A");
			assert.equal(await rd(d, 1), 2);
			assert.equal(await rd(d, 7), 77);
			await (d.store as RemoteStore).close();
		});

		// B reopens its own state after a reload: still in sync, reads work with tombstones in the local store.
		await inBrowser(Bf, async () => {
			const d = await openDataDisk({ template, log, remote: opts });
			assert.equal(await rd(d, 0), 0);
			assert.equal(await rd(d, 8), 88);
			assert.equal((d.store as RemoteStore).manifest!.rev, 2);
			await (d.store as RemoteStore).close();
		});
	} finally {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
