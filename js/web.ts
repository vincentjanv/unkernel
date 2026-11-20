// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// unkernel for browsers: the universal SDK plus HTTP disks with an
// IndexedDB overlay, memory sizing for the device, and the bundled kernel
// fetched (and compiled while it downloads) from next to this module.
// Distro images are not downloaded here (GitHub release assets cannot be
// fetched cross-origin): host alpine.erofs (from a release, with its
// distros.json) yourself and pass its URL, read lazily with Range requests.
//
//   import { createKernel, wispBackend, DEFAULT_WISP_SERVERS } from "unkernel";
//   const vm = await createKernel({ distro: "/distros/alpine.erofs",
//     net: wispBackend(DEFAULT_WISP_SERVERS), onProgress: (p) => console.log(p) });
//   vm.onOutput((b) => term.write(b));
//   term.onData((d) => vm.write(d));
//
// Needs JSPI (WebAssembly.Suspending/promising); checkSupport() tells.

import { createKernelOn, type CreateKernelOptions, type KernelHandle, type KernelInstance, type WorkerOption } from "./core/instance.ts";
import type { WorkerKernel } from "./core/worker-host.ts";
import { webPlatform } from "./web/platform.ts";

export * from "./core/index.ts";
export { DATA_DISK_NAME, DATA_DISK_VERSION, IdbStore, dataDiskStore, importDataDisk, openDataDisk, openDistroDisk, openHttpDisk, resetDataDisk, resetHttpDisk } from "./web/disk.ts";
export type { DataDiskNameOptions, HttpDiskOptions, IdbStoreOptions, OpenDataDiskOptions } from "./web/disk.ts";
export { HttpBackend, IdbChunkCache, IdbSyncState, MemBackend, MemChunkCache, MemSyncState, RemoteConflictError, RemoteLeaseError, RemoteStore } from "./web/remote-disk.ts";
export type { ChunkCache, HttpBackendOptions, Manifest, RemoteBackend, RemoteStatus, RemoteStoreOptions } from "./web/remote-disk.ts";
export { DEFAULT_MEMORY_FALLBACK_MIB, autoMemoryMiB, isMobile } from "./web/memory.ts";
export { webCpuBlocker } from "./web/cpu.ts";
export { serveWasiPrograms } from "./web/wasi.ts";

/**
 * The bundled kernel: vmlinux32.wasm with the base initramfs, its command
 * line, the data disk template and the patch to the SMP kernel in custom
 * sections, next to this module (bundlers that understand
 * `new URL(..., import.meta.url)` emit it as an asset).
 */
export const bundledKernelUrl: URL = new URL("./unkernel.wasm", import.meta.url);

const platform = webPlatform(bundledKernelUrl);

/**
 * Load, compile and boot a kernel (default: the bundled one, which boots
 * `distro`, or without one the base shell) and return the running
 * instance. Rejects with a BootError if it cannot start.
 * Memory defaults to autoMemoryMiB() with DEFAULT_MEMORY_FALLBACK_MIB. With
 * `worker: true` the kernel is loaded, compiled and run in a Web Worker and
 * the result is a WorkerKernel (experimental; disks and the network as
 * specs, see WorkerOption).
 */
export function createKernel(opts: CreateKernelOptions & { worker: true }): Promise<WorkerKernel>;
export function createKernel(opts?: CreateKernelOptions & { worker?: false }): Promise<KernelInstance>;
export function createKernel(opts?: CreateKernelOptions & WorkerOption): Promise<KernelHandle>;
export function createKernel(opts: CreateKernelOptions & WorkerOption = {}): Promise<KernelHandle> {
	return createKernelOn(platform, opts);
}
