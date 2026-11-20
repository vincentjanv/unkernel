// SPDX-License-Identifier: MIT
// A local disk server for the remote-synced disk (js/web/remote-disk.ts):
// the REST protocol of HttpBackend on plain files. Zero dependencies.
//
//   node web/scripts/disk-server.ts --dir ./disk-data --port 8787 --token secret
//   page: http://localhost:8080/?remote=http://localhost:8787/disks/my-disk&token=secret
//
// Layout: <dir>/<disk>/manifest.json and <dir>/<disk>/chunks/<sha256>.
// The same protocol runs on a Cloudflare Worker (R2 for chunks, a Durable
// Object for the manifest and the lease).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENTRY_RE = /^[0-9a-f]{64}:[0-9a-f]{16}$/;
const MAX_CHUNK = 1024 * 1024;
const MAX_MANIFEST = 4 * 1024 * 1024;

export interface DiskServerOptions {
	dir: string;
	/** If set, every request needs "Authorization: Bearer <token>". */
	token?: string;
	/** Allowed browser origin for CORS ("*" by default). */
	origin?: string;
	now?: () => number;
}

interface Lease { owner: string; until: number }

export function createDiskServer({ dir, token, origin = "*", now = Date.now }: DiskServerOptions): http.Server {
	const root = path.resolve(dir);
	fs.mkdirSync(root, { recursive: true });
	const leases = new Map<string, Lease>();

	const cors = (res: http.ServerResponse) => {
		res.setHeader("access-control-allow-origin", origin);
		res.setHeader("access-control-allow-methods", "GET, PUT, POST, DELETE, OPTIONS");
		res.setHeader("access-control-allow-headers", "authorization, content-type, if-match, if-none-match, x-owner");
		res.setHeader("access-control-expose-headers", "etag");
		res.setHeader("access-control-max-age", "86400");
	};
	const send = (res: http.ServerResponse, status: number, body?: string | Buffer, headers: Record<string, string> = {}) => {
		res.writeHead(status, headers);
		res.end(body);
	};
	const json = (res: http.ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}) =>
		send(res, status, JSON.stringify(v), { "content-type": "application/json", ...headers });

	const authorized = (req: http.IncomingMessage): boolean => {
		if (!token) return true;
		const got = Buffer.from(req.headers.authorization ?? ""), want = Buffer.from(`Bearer ${token}`);
		return got.length === want.length && timingSafeEqual(got, want);
	};

	const readBody = (req: http.IncomingMessage, max: number): Promise<Buffer> =>
		new Promise((resolve, reject) => {
			const parts: Buffer[] = [];
			let n = 0;
			req.on("data", (c: Buffer) => {
				n += c.length;
				if (n > max) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
				parts.push(c);
			});
			req.on("end", () => resolve(Buffer.concat(parts)));
			req.on("error", reject);
		});

	const atomicWrite = (file: string, data: Buffer | string) => {
		const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, file);
	};

	const readManifest = (disk: string): { rev: number; raw: string } | null => {
		try {
			const raw = fs.readFileSync(path.join(root, disk, "manifest.json"), "utf8");
			return { rev: (JSON.parse(raw) as { rev: number }).rev, raw };
		} catch { return null; }
	};
	const etagOf = (rev: number) => `"${rev}"`;
	const stripEtag = (v: string) => v.replace(/^W\//, "").replace(/^"|"$/g, "");

	const server = http.createServer(async (req, res) => {
		cors(res);
		try {
			if (req.method === "OPTIONS") return send(res, 204);
			if (!authorized(req)) return send(res, 401, "unauthorized");
			const url = new URL(req.url ?? "/", "http://x");
			const m = /^\/disks\/([^/]+)\/(manifest|lease|chunks\/([0-9a-f]{64}))$/.exec(url.pathname);
			if (!m || !ID_RE.test(m[1]!)) return send(res, 404, "not found");
			const disk = m[1]!, what = m[2]!;
			const diskDir = path.join(root, disk);

			// --- manifest ---------------------------------------------------------
			if (what === "manifest") {
				if (req.method === "GET") {
					const cur = readManifest(disk);
					return cur ? send(res, 200, cur.raw, { "content-type": "application/json", etag: etagOf(cur.rev), "cache-control": "no-store" }) : send(res, 404, "no manifest");
				}
				if (req.method === "PUT") {
					const owner = String(req.headers["x-owner"] ?? "");
					const lease = leases.get(disk);
					if (!owner || !lease || lease.owner !== owner || lease.until < now()) return send(res, 423, "lease not held");
					const body = await readBody(req, MAX_MANIFEST);
					let mf: { v: number; rev: number; uid: string; identity: string; chunks: Record<string, string>; gen: number; seeded: boolean };
					try { mf = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, "bad json"); }
					if (mf.v !== 1 || !Number.isInteger(mf.rev) || typeof mf.uid !== "string" || typeof mf.chunks !== "object" || !mf.chunks) return send(res, 400, "bad manifest");
					const cur = readManifest(disk);
					const ifMatch = req.headers["if-match"], ifNone = req.headers["if-none-match"];
					if (cur ? !(typeof ifMatch === "string" && stripEtag(ifMatch) === String(cur.rev)) : ifNone !== "*") return send(res, 412, "precondition failed");
					if (mf.rev !== (cur?.rev ?? 0) + 1) return send(res, 400, "rev must increase by one");
					// A manifest never names a chunk the server does not have.
					for (const [idx, entry] of Object.entries(mf.chunks)) {
						if (!/^\d{1,9}$/.test(idx) || !ENTRY_RE.test(entry)) return send(res, 400, "bad chunk entry");
						if (!fs.existsSync(path.join(diskDir, "chunks", entry.slice(0, 64)))) return send(res, 400, `missing chunk ${entry.slice(0, 64)}`);
					}
					fs.mkdirSync(diskDir, { recursive: true });
					atomicWrite(path.join(diskDir, "manifest.json"), JSON.stringify(mf));
					return send(res, 200, "", { etag: etagOf(mf.rev) });
				}
				return send(res, 405, "method not allowed");
			}

			// --- lease ------------------------------------------------------------
			if (what === "lease") {
				if (req.method === "POST") {
					let b: { owner?: string; ttlMs?: number; steal?: boolean };
					try { b = JSON.parse((await readBody(req, 4096)).toString("utf8")); } catch { return send(res, 400, "bad json"); }
					if (typeof b.owner !== "string" || !/^[0-9a-f]{4,64}$/.test(b.owner)) return send(res, 400, "bad owner");
					const ttl = Math.min(3_600_000, Math.max(1000, Number(b.ttlMs) || 60_000));
					const cur = leases.get(disk);
					if (cur && cur.owner !== b.owner && cur.until > now() && !b.steal) return json(res, 200, { ok: false, owner: cur.owner, until: cur.until });
					const l = { owner: b.owner, until: now() + ttl };
					leases.set(disk, l);
					return json(res, 200, { ok: true, until: l.until });
				}
				if (req.method === "DELETE") {
					const owner = url.searchParams.get("owner");
					if (leases.get(disk)?.owner === owner) leases.delete(disk);
					return send(res, 204);
				}
				return send(res, 405, "method not allowed");
			}

			// --- chunks -----------------------------------------------------------
			const hash = m[3]!;
			const file = path.join(diskDir, "chunks", hash);
			if (req.method === "GET") {
				if (!fs.existsSync(file)) return send(res, 404, "no chunk");
				return send(res, 200, fs.readFileSync(file), { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" });
			}
			if (req.method === "PUT") {
				if (fs.existsSync(file)) { req.resume(); return send(res, 200, "exists"); }
				const body = await readBody(req, MAX_CHUNK);
				// Check the content against its name: one byte of encoding, then raw or gzip canonical bytes.
				let canonical: Buffer;
				try {
					if (body[0] === 0) canonical = body.subarray(1);
					else if (body[0] === 1) canonical = gunzipSync(body.subarray(1), { maxOutputLength: MAX_CHUNK });
					else return send(res, 400, "bad chunk encoding");
				} catch { return send(res, 400, "bad chunk"); }
				if (createHash("sha256").update(canonical).digest("hex") !== hash) return send(res, 400, "hash mismatch");
				fs.mkdirSync(path.join(diskDir, "chunks"), { recursive: true });
				atomicWrite(file, body);
				return send(res, 200, "stored");
			}
			return send(res, 405, "method not allowed");
		} catch (e) {
			const status = (e as { status?: number }).status ?? 500;
			if (!res.headersSent) send(res, status, status === 500 ? "server error" : (e as Error).message);
			if (status === 500) console.error(e);
		}
	});
	return server;
}

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dir = arg("dir", "./disk-data")!, port = Number(arg("port", "8787")), host = arg("host", "127.0.0.1")!;
	const token = arg("token", process.env.DISK_TOKEN), origin = arg("origin", "*");
	createDiskServer({ dir, token, origin }).listen(port, host, () => {
		console.log(`disk server on http://${host}:${port}/disks/<name>  (storage: ${path.resolve(dir)}${token ? ", token required" : ", NO token"})`);
	});
}
