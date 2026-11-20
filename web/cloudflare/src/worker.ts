// SPDX-License-Identifier: MIT
// Cloudflare Worker: the disk sync API of js/web/remote-disk.ts (HttpBackend).
//
//   GET    /disks/<id>/manifest            200 + ETag | 404
//   PUT    /disks/<id>/manifest            If-Match | If-None-Match: *, X-Owner  -> 200 | 412 | 423
//   POST   /disks/<id>/lease               {owner, ttlMs, steal}
//   DELETE /disks/<id>/lease?owner=
//   GET    /disks/<id>/chunks/<sha256>     immutable
//   PUT    /disks/<id>/chunks/<sha256>     verified against its name
//
// Chunks live in R2 (<id>/chunks/<hash>); the manifest and the lease live in
// one Durable Object per disk, so the compare-and-swap is serialized and the
// lease clock is the server's.
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

interface Env {
	CHUNKS: R2Bucket;
	DISK: DurableObjectNamespace<DiskDO>;
	/** Optional bearer token (wrangler secret put TOKEN). Without it the API is open to anyone who has the URL. */
	TOKEN?: string;
	ALLOWED_ORIGIN?: string;
	/** Cloudflare Access: team domain (<team>.cloudflareaccess.com) and the application's AUD tag. Both set = every request must carry a valid Access token. */
	ACCESS_TEAM?: string;
	ACCESS_AUD?: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENTRY_RE = /^[0-9a-f]{64}:[0-9a-f]{16}$/;
const MAX_CHUNK = 1024 * 1024;
const MAX_CANONICAL = 8 + 64 * 4096;
const MAX_MANIFEST = 4 * 1024 * 1024;

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

function corsHeaders(env: Env): Record<string, string> {
	return {
		"access-control-allow-origin": env.ALLOWED_ORIGIN ?? "*",
		"access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
		"access-control-allow-headers": "authorization, content-type, if-match, if-none-match, x-owner",
		"access-control-expose-headers": "etag",
		"access-control-max-age": "86400",
	};
}

/** Gunzip with an output cap (a chunk is at most 256 KiB + 8 bytes). */
async function gunzipCapped(body: Uint8Array, cap: number): Promise<Uint8Array | null> {
	const ds = new DecompressionStream("gzip");
	const w = ds.writable.getWriter();
	w.write(body).then(() => w.close()).catch(() => {});
	const reader = ds.readable.getReader();
	const parts: Uint8Array[] = [];
	let n = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			n += value.length;
			if (n > cap) { await reader.cancel(); return null; }
			parts.push(value);
		}
	} catch { return null; }
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

const DISTRO_RE = /^[a-z0-9]+-([0-9a-f]{16})\.(?:erofs|ext4)$/;
const ISOLATION = {
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-resource-policy": "same-origin",
};

/**
 * /distros/<name>-<16 hex>.erofs: a distro image of the page, kept in R2
 * (_distros/<name>; Workers static assets stop at 25 MiB a file). The same
 * answers as web/server/range.ts: the file as it is, one Range per request
 * (206 with Content-Range, 416 past the end), a strong ETag from the name's
 * hash and the size on every response, If-None-Match before Range, If-Range,
 * the isolation headers the cross-origin-isolated page needs, immutable.
 */
async function serveDistro(req: Request, env: Env, name: string): Promise<Response> {
	const fail = (status: number, text: string, extra: Record<string, string> = {}) =>
		new Response(req.method === "HEAD" ? null : `${text}\n`, { status, headers: { ...ISOLATION, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", ...extra } });
	const m = DISTRO_RE.exec(name);
	if (!m) return fail(404, `no distro image ${name}`);
	if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "GET or HEAD only", { allow: "GET, HEAD" });
	const key = `_distros/${name}`;
	const head = await env.CHUNKS.head(key);
	if (!head) return fail(404, `no distro image ${name}`);
	const size = head.size;
	const etag = `"${m[1]}-${size.toString(16)}"`;
	const headers: Record<string, string> = { ...ISOLATION, "accept-ranges": "bytes", etag, "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" };
	const inm = req.headers.get("if-none-match");
	if (inm && (inm.trim() === "*" || inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))) return new Response(null, { status: 304, headers });
	let status = 200, start = 0, end = size - 1;
	const range = req.headers.get("range"), ifRange = req.headers.get("if-range");
	if (range && (!ifRange || ifRange.trim() === etag)) {
		const r = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
		if (r && (r[1] || r[2])) {
			if (r[1]) {
				start = Number(r[1]);
				end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
			} else {
				start = Math.max(0, size - Number(r[2]));
				if (Number(r[2]) === 0) start = size; // bytes=-0: nothing
			}
			if (start > end || start >= size) return fail(416, "range not satisfiable", { "content-range": `bytes */${size}` });
			status = 206;
			headers["content-range"] = `bytes ${start}-${end}/${size}`;
		}
	}
	headers["content-length"] = String(end - start + 1);
	if (req.method === "HEAD" || size === 0) return new Response(null, { status, headers });
	const obj = await env.CHUNKS.get(key, status === 206 ? { range: { offset: start, length: end - start + 1 } } : undefined);
	if (!obj || !("body" in obj)) return fail(404, `no distro image ${name}`);
	return new Response(obj.body, { status, headers });
}

const b64u = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
let jwks: { at: number; keys: JsonWebKey[] } | null = null;

/** The Cf-Access-Jwt-Assertion token Cloudflare Access adds after it let someone in: RS256 signature, audience, issuer, expiry. */
async function accessOk(req: Request, env: Env): Promise<boolean> {
	const jwt = req.headers.get("cf-access-jwt-assertion");
	const parts = jwt?.split(".");
	if (!parts || parts.length !== 3) return false;
	try {
		const header = JSON.parse(new TextDecoder().decode(b64u(parts[0]!))) as { kid?: string; alg?: string };
		const claims = JSON.parse(new TextDecoder().decode(b64u(parts[1]!))) as { aud?: string[] | string; iss?: string; exp?: number; nbf?: number };
		if (header.alg !== "RS256") return false;
		const now = Date.now() / 1000;
		if (claims.iss !== `https://${env.ACCESS_TEAM}` || !(claims.exp && claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return false;
		if (![claims.aud].flat().includes(env.ACCESS_AUD)) return false;
		if (!jwks || Date.now() - jwks.at > 3600_000 || !jwks.keys.some((k) => (k as { kid?: string }).kid === header.kid)) {
			const r = await fetch(`https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`);
			if (!r.ok) return false;
			jwks = { at: Date.now(), keys: ((await r.json()) as { keys: JsonWebKey[] }).keys };
		}
		const jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === header.kid);
		if (!jwk) return false;
		const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
		return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
	} catch {
		return false;
	}
}

/**
 * /wisp: a Wisp v1 proxy (https://github.com/MercuryWorkshop/wisp-protocol), the guest's network of the page:
 * its TCP connections, multiplexed over one WebSocket, opened from here with cloudflare:sockets. It sits behind
 * Access like everything else. Packets: [type u8][stream u32 LE][payload]; CONNECT 1 (type u8, port u16, host),
 * DATA 2, CONTINUE 3 (u32 credit), CLOSE 4 (reason u8).
 */
const WISP_CREDIT = 128;
function wisp(req: Request): Response {
	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
	const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
	server.accept();
	server.binaryType = "arraybuffer";
	const send = (type: number, id: number, payload: Uint8Array = new Uint8Array(0)) => {
		const p = new Uint8Array(5 + payload.length);
		p[0] = type;
		new DataView(p.buffer).setUint32(1, id, true);
		p.set(payload, 5);
		try { server.send(p); } catch { /* closed */ }
	};
	const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
	const streams = new Map<number, { writer: WritableStreamDefaultWriter<Uint8Array>; socket: Socket }>();
	const close = (id: number, reason: number) => {
		const s = streams.get(id);
		if (!s) return;
		streams.delete(id);
		try { s.socket.close().catch(() => {}); } catch { /* already closed */ }
		send(0x04, id, Uint8Array.of(reason));
	};
	send(0x03, 0, u32(WISP_CREDIT));
	server.addEventListener("message", async (e) => {
		if (!(e.data instanceof ArrayBuffer)) return;
		const m = new Uint8Array(e.data);
		if (m.length < 5) return;
		const dv = new DataView(m.buffer);
		const id = dv.getUint32(1, true);
		if (m[0] === 0x01) {
			if (m.length < 9 || m[5] !== 0x01 || streams.has(id)) { send(0x04, id, Uint8Array.of(0x41)); return; } // TCP only
			const port = dv.getUint16(6, true), host = new TextDecoder().decode(m.subarray(8));
			try {
				const socket = connect({ hostname: host, port });
				const writer = socket.writable.getWriter();
				streams.set(id, { writer, socket });
				void (async () => {
					const reader = socket.readable.getReader();
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							for (let o = 0; o < value.length; o += 16384) send(0x02, id, value.subarray(o, o + 16384));
						}
						close(id, 0x02);
					} catch { close(id, 0x03); }
				})();
				void socket.closed.catch(() => close(id, 0x44));
			} catch { send(0x04, id, Uint8Array.of(0x42)); }
		} else if (m[0] === 0x02) {
			const s = streams.get(id);
			if (!s) return;
			try { await s.writer.write(m.subarray(5)); send(0x03, id, u32(WISP_CREDIT)); } catch { close(id, 0x03); }
		} else if (m[0] === 0x04) {
			const s = streams.get(id);
			if (s) { streams.delete(id); try { s.socket.close().catch(() => {}); } catch { /* */ } }
		}
	});
	const done = () => { for (const [id] of [...streams]) close(id, 0x02); };
	server.addEventListener("close", done);
	server.addEventListener("error", done);
	return new Response(null, { status: 101, webSocket: client });
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const cors = corsHeaders(env);
		const reply = (status: number, body?: BodyInit | null, headers: Record<string, string> = {}) => new Response(body ?? null, { status, headers: { ...cors, ...headers } });
		if (env.ACCESS_TEAM && env.ACCESS_AUD && !(await accessOk(req, env))) return reply(403, "forbidden: sign in through Cloudflare Access");
		if (req.method === "OPTIONS") return reply(204);
		if (new URL(req.url).pathname === "/wisp") return wisp(req);
		// The page's images are public (like its other files); the token guards the disks only.
		const dm = /^\/distros\/([^/]+)$/.exec(new URL(req.url).pathname);
		if (dm) return serveDistro(req, env, dm[1]!);
		// No TOKEN secret: the API is open (put Cloudflare Access in front of it, or `wrangler secret put TOKEN`).
		if (env.TOKEN) {
			const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
			if (!m || !(await timingSafeEqual(m[1]!, env.TOKEN))) return reply(401, "unauthorized");
		}

		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/") {
			return reply(200, "unkernel disk sync server: up.\nA disk is at /disks/<name>/ (status) and /disks/<name>/manifest.\n", { "content-type": "text/plain" });
		}
		const st = /^\/disks\/([^/]+)\/?$/.exec(url.pathname);
		if (st && ID_RE.test(st[1]!) && req.method === "GET") {
			const res = await env.DISK.get(env.DISK.idFromName(st[1]!)).fetch(new Request("https://disk/status"));
			const out = new Response(res.body, res);
			for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
			return out;
		}
		const r = /^\/disks\/([^/]+)\/(manifest|lease|chunks\/([0-9a-f]{64}))$/.exec(url.pathname);
		if (!r || !ID_RE.test(r[1]!)) return reply(404, "not found");
		const disk = r[1]!, what = r[2]!;

		if (what === "manifest" || what === "lease") {
			const stub = env.DISK.get(env.DISK.idFromName(disk));
			const fwd = new Request(`https://disk/${what}${url.search}`, { method: req.method, headers: { ...Object.fromEntries(req.headers), "x-disk": disk }, body: req.method === "GET" || req.method === "DELETE" ? null : req.body });
			const res = await stub.fetch(fwd);
			const out = new Response(res.body, res);
			for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
			return out;
		}

		const hash = r[3]!;
		const key = `${disk}/chunks/${hash}`;
		if (req.method === "GET") {
			const obj = await env.CHUNKS.get(key);
			if (!obj) return reply(404, "no chunk");
			return reply(200, obj.body, { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag });
		}
		if (req.method === "PUT") {
			if (await env.CHUNKS.head(key)) return reply(200, "exists");
			const len = Number(req.headers.get("content-length") ?? 0);
			if (len > MAX_CHUNK) return reply(413, "too large");
			const body = new Uint8Array(await req.arrayBuffer());
			if (body.length > MAX_CHUNK || body.length < 1) return reply(413, "bad size");
			let canonical: Uint8Array | null;
			if (body[0] === 0) canonical = body.subarray(1);
			else if (body[0] === 1) canonical = await gunzipCapped(body.subarray(1), MAX_CANONICAL);
			else return reply(400, "bad chunk encoding");
			if (!canonical || canonical.length > MAX_CANONICAL) return reply(400, "bad chunk");
			if (hex(await crypto.subtle.digest("SHA-256", canonical)) !== hash) return reply(400, "hash mismatch");
			await env.CHUNKS.put(key, body);
			return reply(200, "stored");
		}
		return reply(405, "method not allowed");
	},
} satisfies ExportedHandler<Env>;

interface Lease { owner: string; until: number }
interface StoredManifest { rev: number; raw: string }

/** One per disk: the manifest (compare-and-swap) and the writer lease. */
export class DiskDO extends DurableObject<Env> {
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const json = (status: number, v: unknown, headers: Record<string, string> = {}) =>
			new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
		const text = (status: number, t: string, headers: Record<string, string> = {}) => new Response(t, { status, headers });
		const etagOf = (rev: number) => `"${rev}"`;
		const store = this.ctx.storage;

		if (url.pathname === "/status") {
			const cur = await store.get<StoredManifest>("manifest");
			if (!cur) return json(200, { disk: "empty (nothing pushed yet)", manifest: null });
			const m = JSON.parse(cur.raw) as { rev: number; chunks: Record<string, string>; seeded: boolean; updatedAt: number };
			return json(200, { disk: "ok", manifest: { rev: m.rev, chunks: Object.keys(m.chunks).length, seeded: m.seeded, updatedAt: new Date(m.updatedAt).toISOString() } });
		}

		if (url.pathname === "/manifest") {
			if (req.method === "GET") {
				const cur = await store.get<StoredManifest>("manifest");
				return cur ? text(200, cur.raw, { "content-type": "application/json", etag: etagOf(cur.rev), "cache-control": "no-store" }) : text(404, "no manifest");
			}
			if (req.method === "PUT") {
				// Held for the whole check-and-write: the R2 lookups below would otherwise let another request in between.
				return this.ctx.blockConcurrencyWhile(async () => {
					const disk = req.headers.get("x-disk")!;
					const owner = req.headers.get("x-owner") ?? "";
					const lease = await store.get<Lease>("lease");
					if (!owner || !lease || lease.owner !== owner || lease.until < Date.now()) return text(423, "lease not held");
					const raw = await req.text();
					if (raw.length > MAX_MANIFEST) return text(413, "too large");
					let mf: { v: number; rev: number; uid: string; chunks: Record<string, string> };
					try { mf = JSON.parse(raw); } catch { return text(400, "bad json"); }
					if (mf.v !== 1 || !Number.isInteger(mf.rev) || typeof mf.uid !== "string" || !mf.chunks || typeof mf.chunks !== "object") return text(400, "bad manifest");
					const cur = await store.get<StoredManifest>("manifest");
					const ifMatch = req.headers.get("if-match"), ifNone = req.headers.get("if-none-match");
					const matches = cur ? ifMatch !== null && ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "") === String(cur.rev) : ifNone === "*";
					if (!matches) return text(412, "precondition failed");
					if (mf.rev !== (cur?.rev ?? 0) + 1) return text(400, "rev must increase by one");
					const heads: Promise<R2Object | null>[] = [];
					for (const [idx, entry] of Object.entries(mf.chunks)) {
						if (!/^\d{1,9}$/.test(idx) || !ENTRY_RE.test(entry)) return text(400, "bad chunk entry");
						heads.push(this.env.CHUNKS.head(`${disk}/chunks/${entry.slice(0, 64)}`));
					}
					// A manifest never names a chunk R2 does not have.
					if ((await Promise.all(heads)).some((h) => h === null)) return text(400, "missing chunk");
					await store.put("manifest", { rev: mf.rev, raw } satisfies StoredManifest);
					return text(200, "", { etag: etagOf(mf.rev) });
				});
			}
			return text(405, "method not allowed");
		}

		if (url.pathname === "/lease") {
			if (req.method === "POST") {
				let b: { owner?: string; ttlMs?: number; steal?: boolean };
				try { b = await req.json(); } catch { return text(400, "bad json"); }
				if (typeof b.owner !== "string" || !/^[0-9a-f]{4,64}$/.test(b.owner)) return text(400, "bad owner");
				const ttl = Math.min(3_600_000, Math.max(1000, Number(b.ttlMs) || 60_000));
				const cur = await store.get<Lease>("lease");
				const now = Date.now();
				if (cur && cur.owner !== b.owner && cur.until > now && !b.steal) return json(200, { ok: false, owner: cur.owner, until: cur.until });
				const l: Lease = { owner: b.owner, until: now + ttl };
				await store.put("lease", l);
				return json(200, { ok: true, until: l.until });
			}
			if (req.method === "DELETE") {
				const cur = await store.get<Lease>("lease");
				if (cur && cur.owner === url.searchParams.get("owner")) await store.delete("lease");
				return text(204, "");
			}
			return text(405, "method not allowed");
		}
		return text(404, "not found");
	}
}
