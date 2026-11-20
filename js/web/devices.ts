// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The browser device kinds (core/devices.ts): the persistent "data" disk
// in IndexedDB and "http" disks whose overlay is saved in IndexedDB
// (`persist`; a readOnly one has no overlay). Used by the web platform on
// the page's thread and by the kernel worker (web-worker-entry.ts);
// IndexedDB exists in both.
//
// "data" behaves like the page's attachDataDisk() (web/src/data.ts) once
// the caller has decided the mode: "persistent" opens the store (seeding
// it from the template on first use), and a store that cannot be used (a
// saved disk of another format, IndexedDB refusing) gives a fresh disk in
// memory with a notice saying why; nothing is cleared. The one-tab lock is
// the caller's: it passes mode "snapshot" when another tab holds it.

import { BaseDisk, CowDisk, HttpBase } from "../core/block.ts";
import { bundledBoot } from "../core/kernel.ts";
import { coreDevices, extendDevices, type DataDiskSpec, type DeviceContext, type DeviceRegistry, type HttpDiskSpec } from "../core/devices.ts";
import { IdbStore, openDataDisk } from "./disk.ts";

export const webDevices: DeviceRegistry = extendDevices(coreDevices, {
	disks: {
		async http(spec: HttpDiskSpec, ctx: DeviceContext) {
			const opts = { chunkSize: spec.chunkSize, prefetch: spec.prefetch, log: ctx.log };
			if (spec.readOnly) return new BaseDisk(await HttpBase.open(spec.url, { ...opts, strict: true }));
			const base = await HttpBase.open(spec.url, opts);
			const store = spec.persist && typeof indexedDB !== "undefined" ? new IdbStore(spec.persist, { log: ctx.log }) : null;
			return new CowDisk(base, { store, log: ctx.log, onError: (e) => ctx.onDiskError(ctx.index, e) }).open({ onMismatch: "clear" });
		},
		async data(spec: DataDiskSpec, ctx: DeviceContext) {
			const template = spec.template === "bundled" ? bundledBoot(ctx.module).datadisk : spec.template;
			if (!template) throw new Error("no template (the kernel has no unkernel.datadisk section)");
			const remote = spec.remote && { url: spec.remote.url, token: spec.remote.token, options: { owner: spec.remote.owner } };
			const common = { template, name: spec.name, version: spec.version, log: ctx.log, remote };
			if (spec.mode === "snapshot") return openDataDisk({ ...common, mode: "snapshot", snapshotLimit: spec.snapshotLimit });
			try {
				return await openDataDisk({ ...common, onError: (e) => ctx.onDiskError(ctx.index, e) });
			} catch (e) {
				const err = e as Error;
				ctx.log(`[host] data disk: not attached persistently: ${err.name}: ${err.message}`);
				const disk = await openDataDisk({ ...common, mode: "snapshot", snapshotLimit: 0 });
				const why = err.name === "DataDiskFormatError" ? err.message : `IndexedDB failed (${err.name}: ${err.message})`;
				disk.notice = `${why}; this tab's /data is a fresh disk in memory (changes are not saved)`;
				return disk;
			}
		},
	},
});
