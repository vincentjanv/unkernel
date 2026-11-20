// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The SDK from source (the page is built with it, not with the published
// dist/), with the page's own kernel (virtual:unkernel-kernel, vite.config.ts;
// web/scripts/kernel.ts pageSource() picks it when the dev server starts or
// the page is built): the base bundle unkernel.wasm, which boot.ts starts
// with a distro image (createKernel({ distro })), a hashed Vite asset in a
// build. js/web.ts is not imported, so the SDK's own bundled kernel (the
// symlink into vendor/) is not part of the page.
import { createKernelOn, type CreateKernelOptions, type KernelHandle, type KernelInstance, type WorkerOption } from "../../js/core/instance.ts";
import type { WorkerKernel } from "../../js/core/worker-host.ts";
import { webPlatform } from "../../js/web/platform.ts";
import { kernelSmpUrl, kernelUrl } from "virtual:unkernel-kernel";

export * from "../../js/core/index.ts";
export { DEFAULT_MEMORY_FALLBACK_MIB, autoMemoryMiB } from "../../js/web/memory.ts";
export { DATA_DISK_NAME, importDataDisk, openDataDisk, openDistroDisk, resetDataDisk } from "../../js/web/disk.ts";
export { RemoteConflictError, RemoteLeaseError, RemoteStore, type RemoteStatus } from "../../js/web/remote-disk.ts";
export { webCpuBlocker } from "../../js/web/cpu.ts";
export { serveWasiPrograms } from "../../js/web/wasi.ts";

/**
 * The kernel the page runs on one CPU: the base bundle (vmlinux32.wasm +
 * the base initramfs, kernel/tools/bundle.mjs) without its SMP patch
 * (web/scripts/kernel.ts baseSplit()). And the SMP kernel of the same
 * bundle, its own hashed asset, or null when the bundle has no SMP patch:
 * fetched only when the page boots on more than one CPU (?cpus=N, config.ts;
 * boot.ts).
 */
export { kernelSmpUrl, kernelUrl };

const platform = webPlatform(kernelUrl);

/**
 * js/web.ts's createKernel(), with the page's kernel as the default; with
 * `worker: true` (?worker=1) on a Web Worker (js/web/worker.ts, which Vite
 * bundles as a worker), which starts an SMP kernel's other CPUs as nested
 * workers (js/web/cpu.ts) when `cpus` asks for them.
 */
export function createKernel(opts: CreateKernelOptions & { worker: true }): Promise<WorkerKernel>;
export function createKernel(opts?: CreateKernelOptions & { worker?: false }): Promise<KernelInstance>;
export function createKernel(opts?: CreateKernelOptions & WorkerOption): Promise<KernelHandle>;
export function createKernel(opts: CreateKernelOptions & WorkerOption = {}): Promise<KernelHandle> {
	return createKernelOn(platform, opts);
}
