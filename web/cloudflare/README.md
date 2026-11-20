# Disk sync server on Cloudflare

Hosts the remote-synced data disk (`js/web/remote-disk.ts`) on Cloudflare:
chunks in R2, manifest + writer lease in one Durable Object per disk.
The kernel still runs in the browser; the Worker is only the sync API.

```
cd web/cloudflare
npm install
npx wrangler login                   # authorize in the browser
npx wrangler r2 bucket create unkernel-disks   # R2 must be enabled once in the dashboard
npm run deploy
```

Open the page once with the endpoint (add `&token=...` if you set a TOKEN); it is saved in that
browser and removed from the address bar:

```
https://<your page>/?remote=https://unkernel-disks.<you>.workers.dev/disks/<disk name>
```

`?remote=0` forgets it. Any browser opened the same way gets the same disk.
One browser writes at a time (a lease on the server); another one is told the
disk is open elsewhere and runs on a throwaway copy.

Local trial without an account: `npx wrangler dev --local --var TOKEN:test`, or
the file-based server `node web/scripts/disk-server.ts --dir ./disk-data --token test`.
Check either with `DISK_URL=http://127.0.0.1:8787 DISK_TOKEN=test node --test test/remote-disk-live.test.ts`.

Set `ALLOWED_ORIGIN` in `wrangler.jsonc` to your page's origin once it is hosted.
Orphaned chunks (replaced by newer pushes) are not garbage-collected yet.

## Authentication

By default there is none: without a `TOKEN` secret the API is open to anyone
who has the URL, and they can read and write your R2 storage. Put Cloudflare
Access in front of the Worker before sharing the URL, or add a shared token
with `npx wrangler secret put TOKEN` (the page then needs `&token=...`).

## The page on the same address

`npm run deploy:page` (in this folder) builds the page, uploads its distro
images to R2 (`_distros/`, they are over the 25 MiB limit of static assets) and
deploys the Worker with the page as its static assets. Then
`https://<worker>.workers.dev/` is the page, it syncs its data disk to
`/disks/home` on the same address, and there is nothing to configure in the
browser. Only `/disks/*` and `/distros/*` run the Worker; every other request
is a static file. Cloudflare Access, when you add it, covers all of it at once.
