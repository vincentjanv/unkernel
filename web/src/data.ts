// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's persistent data disk: an ext4 file system labelled kwdata (the
// guest mounts it at /data) kept in IndexedDB (the SDK's openDataDisk). This
// module owns the browser side: the template, the one-tab-at-a-time lock,
// storage persistence and quota, and export, import and reset. boot.ts
// calls attachDataDisk() and wires the rest to KW.*.
import { DATA_DISK_NAME, RemoteConflictError, RemoteLeaseError, RemoteStore, gzipBlob, importDataDisk, openDataDisk, resetDataDisk, type CowDisk, type RemoteStatus } from "./sdk.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DiskLock {
	held: boolean;
	how: string;
	why?: unknown;
}

/**
 * Hold the disk for this page's lifetime, if no other tab does:
 * navigator.locks (secure contexts), else a BroadcastChannel probe (plain
 * http LAN pages are not a secure context; two tabs opened in the same
 * instant may both win there).
 */
export function acquireDiskLock(name = DATA_DISK_NAME): Promise<DiskLock> {
	const key = `kwdisk:${name}`;
	if (navigator.locks?.request) {
		return new Promise((resolve) => {
			navigator.locks.request(key, { ifAvailable: true }, (lock) => {
				resolve({ held: !!lock, how: "Web Locks" });
				if (lock) return new Promise<void>(() => {}); // released when the page goes away
				return undefined;
			}).catch((e: unknown) => resolve(probeLock(key, e)));
		});
	}
	return probeLock(key);
}

async function probeLock(key: string, why?: unknown): Promise<DiskLock> {
	if (typeof BroadcastChannel !== "function") return { held: true, how: "none (no Web Locks or BroadcastChannel)", why };
	const ch = new BroadcastChannel(key);
	let held = false, taken = false;
	ch.onmessage = (e: MessageEvent) => {
		if (e.data?.type === "held") taken = true;
		else if (e.data?.type === "probe" && held) ch.postMessage({ type: "held" });
	};
	ch.postMessage({ type: "probe" });
	await sleep(300);
	if (taken) {
		ch.close();
		return { held: false, how: "BroadcastChannel" };
	}
	held = true; // the channel stays open and answers probes for the page's lifetime
	return { held: true, how: "BroadcastChannel" };
}

/** The template: the kernel bundle's custom section unkernel.datadisk (kernel/build.sh datadisk, bundle). */
export function loadTemplate(bundled: Uint8Array | undefined): { bytes: Uint8Array | null; from: string } {
	return bundled ? { bytes: bundled, from: "bundled in the kernel" } : { bytes: null, from: "the kernel has no unkernel.datadisk section" };
}

export const fmtSize = (n: number): string =>
	n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GiB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.round(n / 1024)} KiB`;

export interface StorageState {
	persisted?: boolean;
	usage?: number;
	quota?: number;
}

/** navigator.storage: persistence (asked for with `ask`), usage and quota; fields undefined where unsupported. */
export async function storageState({ ask = false }: { ask?: boolean } = {}): Promise<StorageState> {
	const s = navigator.storage;
	const out: StorageState = {};
	try {
		if (ask && s?.persist) out.persisted = await s.persist();
		else if (s?.persisted) out.persisted = await s.persisted();
	} catch {}
	try {
		if (s?.estimate) {
			const e = await s.estimate();
			out.usage = e.usage;
			out.quota = e.quota;
		}
	} catch {}
	return out;
}

export interface RemoteConfig {
	url: string;
	token?: string;
	/** This browser's stable lease owner id: after a reload the browser takes its own lease back at once. */
	owner: string;
}

const REMOTE_KEY = "kwremote";
const OWNER_KEY = "kwremote-owner";

const randomOwner = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

function browserOwner(): string {
	try {
		let o = localStorage.getItem(OWNER_KEY);
		if (!o || !/^[0-9a-f]{16}$/.test(o)) localStorage.setItem(OWNER_KEY, (o = randomOwner()));
		return o;
	} catch {
		return randomOwner();
	}
}

/**
 * Where this browser syncs the data disk to: the build's default
 * (VITE_KW_REMOTE, e.g. in web/.env.local; a relative URL is resolved against
 * the page), or one chosen per browser with ?remote=<url of the disk>&token=<token>
 * (saved in localStorage, then taken out of the address bar so the token does not
 * stay in the history). ?remote=0 turns it off in this browser, ?remote=default
 * goes back to the build's default. <url> is the disk's endpoint, e.g.
 * https://unkernel-disks.<you>.workers.dev/disks/home.
 */
export function readRemote(): RemoteConfig | null {
	try {
		const u = new URL(location.href), p = u.searchParams;
		if (p.has("remote")) {
			const v = p.get("remote") ?? "";
			if (v === "" || v === "default") localStorage.removeItem(REMOTE_KEY);
			else if (v === "0" || v === "off") localStorage.setItem(REMOTE_KEY, JSON.stringify({ off: true }));
			else localStorage.setItem(REMOTE_KEY, JSON.stringify({ url: v, token: p.get("token") ?? undefined }));
			p.delete("remote");
			p.delete("token");
			history.replaceState(null, "", u);
		}
		const raw = localStorage.getItem(REMOTE_KEY);
		const saved = raw ? (JSON.parse(raw) as { url?: string; token?: string; off?: boolean }) : null;
		if (saved?.off) return null;
		const url = typeof saved?.url === "string" ? saved.url : (import.meta.env.VITE_KW_REMOTE ?? "");
		if (!url) return null;
		return { url: new URL(url, location.href).href, token: saved?.token, owner: browserOwner() };
	} catch {
		return null;
	}
}

export interface DataAttach {
	/** null: no data disk (reason says why). */
	disk: CowDisk | null;
	lock: DiskLock | null;
	/** Attached, but not persistently: why. */
	notice?: string;
	reason?: string;
	/** Where the template came from. */
	from?: string;
	/** The disk is synced to a server: its store (status, syncNow()). */
	remote?: RemoteStore;
}

/** Open the data disk for this page. */
export async function attachDataDisk({ enabled, bundled, log, onError, onRemoteStatus }: {
	enabled: boolean;
	bundled: Uint8Array | undefined;
	log: (m: string) => void;
	onError: (e: unknown) => void;
	onRemoteStatus?: (s: RemoteStatus) => void;
}): Promise<DataAttach> {
	if (!enabled) return { disk: null, lock: null, reason: "off (?data=0)" };
	if (typeof indexedDB === "undefined") return { disk: null, lock: null, reason: "no IndexedDB in this browser" };
	const tpl = loadTemplate(bundled);
	if (!tpl.bytes) return { disk: null, lock: null, reason: `no template (${tpl.from})` };
	const lock = await acquireDiskLock();
	if (!lock.held) {
		const disk = await openDataDisk({ template: tpl.bytes, mode: "snapshot", log });
		return { disk, lock, from: tpl.from, notice: `open in another tab: this tab's /data is ${disk.notice} (changes are not saved)` };
	}
	const rc = readRemote();
	try {
		const disk = await openDataDisk({
			template: tpl.bytes, log, onError,
			remote: rc ? { url: rc.url, token: rc.token, options: { log, owner: rc.owner, onStatus: (s) => {
				log(`[remote] ${s.state}, revision ${s.rev}, ${s.dirtyBlocks} unsynced blocks${s.error ? `: ${s.error}` : ""}`);
				onRemoteStatus?.(s);
			} } } : undefined,
		});
		const remote = disk.store instanceof RemoteStore ? disk.store : undefined;
		if (remote) watchPage(remote);
		return { disk, lock, from: tpl.from, remote };
	} catch (e) {
		// A saved disk of another format, or IndexedDB refusing (private
		// browsing, disabled storage): run on a copy of the template.
		const err = e as Error;
		log(`[host] data disk: not attached persistently: ${err.name}: ${err.message}`);
		const disk = await openDataDisk({ template: tpl.bytes, mode: "snapshot", log, snapshotLimit: 0 });
		const why = err.name === "DataDiskFormatError" ? err.message
			: err instanceof RemoteLeaseError || err instanceof RemoteConflictError ? err.message
			: rc ? `the remote disk failed (${err.name}: ${err.message})` : `IndexedDB failed (${err.name}: ${err.message})`;
		return { disk, lock, from: tpl.from, notice: `${why}; this tab's /data is a fresh disk in memory (changes are not saved)` };
	}
}

let watching: RemoteStore | null = null;

/** Push when the page is hidden (the best moment before a tab is frozen or closed), and give the lease back when it goes away with nothing unpushed. */
function watchPage(rs: RemoteStore): void {
	void rs.prefetch();
	if (watching) return;
	watching = rs;
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") rs.syncNow().catch(() => {});
	});
	addEventListener("pagehide", () => { rs.releaseIfClean(); });
}

/** Download the disk's current content as a .kwsparse.gz file. */
export async function exportDataDisk(disk: CowDisk): Promise<{ name: string; blocks: number; bytes: number }> {
	const { parts, blocks } = await disk.exportParts();
	return downloadKwsparse(parts, blocks);
}

/** Download kwsparse parts (CowDisk.exportParts(), here or from the kernel worker) as a .kwsparse.gz file. */
export async function downloadKwsparse(parts: BlobPart[], blocks: number): Promise<{ name: string; blocks: number; bytes: number }> {
	const blob = await gzipBlob(parts);
	const name = `kwdata-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.kwsparse.gz`;
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 60000);
	return { name, blocks, bytes: blob.size };
}

/** Stop a running disk's saves (and wait for one in flight) before its store is replaced. */
export async function detachDataDisk(disk: CowDisk | null | undefined): Promise<void> {
	if (!disk) return;
	disk.detach();
	await disk.saving?.catch(() => {});
	await disk.store?.close?.();
}

export { importDataDisk, resetDataDisk };
