// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Device specs: disks and the network device described as plain data, so
// they can cross to a kernel worker (createKernel({ worker: true })) and
// be built there, next to the kernel. Inline, createKernel() builds them
// the same way, on this thread.
//
// A spec is a structured-cloneable object tagged with `kind`. Each kind is
// built by a factory in a DeviceRegistry: the universal ones are below,
// and each platform binding adds its own (js/node/devices.ts: file disks,
// direct networking; js/web/devices.ts: the IndexedDB data disk and HTTP
// disks with a saved overlay). js/core imports neither.
//
// Only kinds somebody uses exist:
//   disks  "file"  a disk image file (Node: FileDisk, or with snapshot an
//                  in-memory overlay over it; the CLI's --disk, --data)
//          "http"  an image served with HTTP Range support under an
//                  overlay (in memory; in browsers saved in IndexedDB
//                  under `persist`; the CLI's --disk URL, openHttpDisk()),
//                  or with readOnly read straight from the server (a
//                  distro image)
//          "data"  the persistent data disk (browsers: IndexedDB, from the
//                  kernel bundle's unkernel.datadisk template or bytes;
//                  the page's /data, openDataDisk())
//   net    a NetStack over a backend: "direct" (Node: host sockets, the
//          CLI's default) or "wisp" (a Wisp server; everywhere)

import { BaseDisk, CowDisk, F_RO, HttpBase, type BlockDevice, type CowDiskStats } from "./block.ts";
import { BootError } from "./load.ts";
import { NetStack, type NetBackend } from "./net.ts";
import { wispBackend } from "./net-wisp.ts";

/** The spec format. A spec may carry `v`; a factory refuses other versions. */
export const DEVICE_SPEC_VERSION = 1;

interface SpecCommon {
	/** Format version, default DEVICE_SPEC_VERSION. */
	v?: number;
	/** If it cannot be built, leave it out (and say why) instead of failing the boot. Later disks move up a letter. */
	optional?: boolean;
}

/** A disk image file on the host (Node). */
export interface FileDiskSpec extends SpecCommon {
	kind: "file";
	/** A path (relative paths are relative to the process's working directory). */
	path: string;
	/** Refuse writes. */
	readOnly?: boolean;
	/** Writes go to an in-memory overlay and are lost at exit (the CLI's --snapshot). */
	snapshot?: boolean;
}

/** An image served over HTTP with Range support, read lazily, under a copy-on-write overlay. */
export interface HttpDiskSpec extends SpecCommon {
	kind: "http";
	/** An absolute URL (a relative one is resolved against the page before it crosses to a worker). */
	url: string;
	chunkSize?: number;
	/** Browsers: keep the overlay in IndexedDB under this name (openHttpDisk's `name`); else it is in memory. */
	persist?: string;
	/** No overlay: the guest's writes fail (EROFS), and every range must come from the image first seen (HttpBase strict). `persist` is ignored. */
	readOnly?: boolean;
	/** Bytes to fetch ahead at open, in one streaming request (HttpBaseOptions.prefetch); default: what the image's distro header says; false: none. */
	prefetch?: number | false;
}

/** The persistent data disk (browsers: IndexedDB; see js/web/disk.ts openDataDisk()). */
export interface DataDiskSpec extends SpecCommon {
	kind: "data";
	/** A kwsparse image (gzipped or not), or "bundled": the kernel module's unkernel.datadisk section. */
	template: Uint8Array | "bundled";
	/** "persistent" (default; the caller holds the one-tab lock) or "snapshot" (memory only, e.g. another tab owns it). */
	mode?: "persistent" | "snapshot";
	/** Store name and format version (default "kwdata", "v1"). */
	name?: string;
	version?: string;
	snapshotLimit?: number;
	/**
	 * Mirror the disk to a server (js/web/remote-disk.ts): the disk's REST
	 * endpoint, an optional bearer token, and this browser's stable owner id
	 * (the writer lease is kept per owner, so a reload takes its own back).
	 */
	remote?: { url: string; token?: string; owner?: string };
}

export type DiskSpec = FileDiskSpec | HttpDiskSpec | DataDiskSpec;

/** The network device: a NetStack over a backend. */
export interface NetSpec extends SpecCommon {
	kind: "net";
	backend:
		| { kind: "direct" }
		| { kind: "wisp"; servers: string | string[]; headers?: Record<string, string> };
	/** TCP to the gateway (10.0.2.2) goes to the host's 127.0.0.1 (direct only). */
	hostLoopback?: boolean;
	mtu?: number;
	mac?: string;
}

export type NetBackendSpec = NetSpec["backend"];

/** What a factory gets besides its spec. */
export interface DeviceContext {
	/** The kernel module (for "bundled" templates). */
	module: WebAssembly.Module;
	log: (msg: string) => void;
	/** A save of disk `index` failed (e.g. QuotaExceededError); the guest sees EIO for that flush. */
	onDiskError: (index: number, error: unknown) => void;
	/** The disk's index in the specs (-1: the distro image). */
	index: number;
}

export interface DeviceRegistry {
	disks: Record<string, (spec: never, ctx: DeviceContext) => Promise<BlockDevice> | BlockDevice>;
	backends: Record<string, (spec: never, ctx: DeviceContext) => NetBackend>;
}

/** The universal kinds: "http" disks with the overlay in memory, and Wisp. */
export const coreDevices: DeviceRegistry = {
	disks: {
		async http(spec: HttpDiskSpec, ctx: DeviceContext) {
			const opts = { chunkSize: spec.chunkSize, prefetch: spec.prefetch, log: ctx.log };
			if (spec.readOnly) return new BaseDisk(await HttpBase.open(spec.url, { ...opts, strict: true }));
			return new CowDisk(await HttpBase.open(spec.url, opts), { log: ctx.log });
		},
	},
	backends: {
		wisp: (spec: Extract<NetBackendSpec, { kind: "wisp" }>, ctx: DeviceContext) =>
			wispBackend(spec.servers, { headers: spec.headers, log: ctx.log }),
	},
};

/** A registry with `more`'s kinds added to (or replacing) `base`'s. */
export function extendDevices(base: DeviceRegistry, more: Partial<DeviceRegistry>): DeviceRegistry {
	return { disks: { ...base.disks, ...more.disks }, backends: { ...base.backends, ...more.backends } };
}

const isPlain = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);

/** A disk spec (plain data), not a BlockDevice object. */
export function isDiskSpec(x: unknown): x is DiskSpec {
	return isPlain(x) && typeof x.kind === "string" && typeof x.read !== "function";
}

/** A network spec, not a NetDevice or NetBackend object. */
export function isNetSpec(x: unknown): x is NetSpec {
	return isPlain(x) && x.kind === "net" && isPlain(x.backend);
}

function checkVersion(spec: SpecCommon & { kind: string }, what: string): void {
	if (spec.v !== undefined && spec.v !== DEVICE_SPEC_VERSION)
		throw new BootError("support", `${what} "${spec.kind}": spec version ${spec.v}, this SDK reads ${DEVICE_SPEC_VERSION}`);
}

/** A disk that a spec marked optional could not be built: why. */
export interface SkippedDisk {
	index: number;
	kind: string;
	reason: string;
}

/**
 * Build the disks: objects are passed through, specs built by `registry`
 * in order. Returns the devices and the optional specs left out.
 */
export async function buildDisks(items: ReadonlyArray<BlockDevice | DiskSpec>, registry: DeviceRegistry | undefined,
	ctx: Omit<DeviceContext, "index">): Promise<{ disks: BlockDevice[]; skipped: SkippedDisk[] }> {
	const disks: BlockDevice[] = [], skipped: SkippedDisk[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		if (!isDiskSpec(item)) {
			disks.push(item);
			continue;
		}
		const make = registry?.disks[item.kind] as ((s: DiskSpec, c: DeviceContext) => Promise<BlockDevice> | BlockDevice) | undefined;
		try {
			checkVersion(item, "disk kind");
			if (!make) throw new BootError("support", `disk kind "${item.kind}" is not available on this platform`);
			disks.push(await make(item, { ...ctx, index }));
		} catch (e) {
			const reason = (e as Error)?.message ?? String(e);
			if (!item.optional) throw e instanceof BootError ? e : new BootError("boot", `disk ${index} (${item.kind}): ${reason}`, { cause: e });
			ctx.log(`[host] disk ${index} (${item.kind}) left out: ${reason}`);
			skipped.push({ index, kind: item.kind, reason });
		}
	}
	return { disks, skipped };
}

/** Build the network device of a spec. */
export function buildNet(spec: NetSpec, registry: DeviceRegistry | undefined, ctx: Omit<DeviceContext, "index">): NetStack | undefined {
	checkVersion(spec, "net");
	const make = registry?.backends[spec.backend.kind] as ((s: NetBackendSpec, c: DeviceContext) => NetBackend) | undefined;
	try {
		if (!make) throw new BootError("support", `network backend "${spec.backend.kind}" is not available on this platform`);
		return new NetStack({ backend: make(spec.backend, { ...ctx, index: 0 }), hostLoopback: spec.hostLoopback, mtu: spec.mtu, mac: spec.mac, log: ctx.log });
	} catch (e) {
		if (!spec.optional) throw e;
		ctx.log(`[host] network left out: ${(e as Error)?.message ?? e}`);
		return undefined;
	}
}

/**
 * What can be read off a disk from another thread (a WorkerKernel's
 * disks): the BlockDevice's flags and flush count, and for a CowDisk its
 * overlay, store and counters.
 */
export interface DiskState {
	/** Its index in the `disks` option (/dev/wda is the first disk that was built; skipped ones take no letter). */
	index: number;
	kind: string;
	size: number;
	readOnly: boolean;
	/** Flushes reach storage that outlives the host (a file, IndexedDB). */
	persistent: boolean;
	flushSeq: number;
	/** A save is in flight. */
	saving: boolean;
	/** CowDisk: blocks that differ from the base (stored or in memory). */
	overlayBlocks?: number;
	/** CowDisk: bytes of block data held in memory. */
	memBytes?: number;
	/** CowDisk with a store: blocks the store holds, its name, whether it was seeded now, and its identity. */
	storedBlocks?: number;
	store?: string;
	seeded?: boolean;
	identity?: string;
	/** CowDisk: why it is not the persistent disk (e.g. "in memory only, started from the template"). */
	notice?: string;
	/** CowDisk: saves no longer reach the store (detached before an import or reset). */
	detached?: boolean;
	cow?: CowDiskStats;
}

/** A snapshot of disk `d` (structured-cloneable). */
export function diskState(d: BlockDevice, index: number, kind: string): DiskState {
	const s: DiskState = {
		index, kind, size: d.size, readOnly: !!d.readOnly || !!((d.flags ?? 0) & F_RO),
		persistent: !!d.persistent, flushSeq: d.flushSeq ?? 0, saving: !!d.saving,
	};
	if (d instanceof CowDisk) {
		s.overlayBlocks = d.overlayBlocks;
		s.memBytes = d.memBytes;
		if (d.store) {
			s.storedBlocks = d.stored.size;
			s.store = d.store.name;
			s.seeded = d.seeded;
			s.identity = d.identity;
			s.detached = !d.persistent;
		}
		if (d.notice) s.notice = d.notice;
		s.cow = { ...d.stats };
	}
	return s;
}
