<p align="center">
	<img width="150" height="150" src="https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/icons/Square310x310Logo.png" alt="Cap logo">
</p>

<h1 align="center">Cap — R2 Fix Fork</h1>

<p align="center">
	Fork of <a href="https://github.com/CapSoftware/Cap">Cap</a> with patches for self-hosted deployment on <strong>Coolify</strong> with <strong>Cloudflare R2</strong> storage.
</p>

<p align="center">
	<a href="https://github.com/CapSoftware/Cap">Upstream</a>
	 |
	<a href="https://cap.so/docs">Docs</a>
</p>

---

> **This is a personal fork** maintained by [@neronlux](https://github.com/neronlux)
> for self-hosting Cap on personal infrastructure. It is **not** affiliated with
> or endorsed by [Cap Software, Inc.](https://github.com/CapSoftware/Cap) All
> upstream Cap features, code, and licensing remain unchanged. If you are looking
> for the official Cap project, go to **[github.com/CapSoftware/Cap](https://github.com/CapSoftware/Cap)**.

## What This Fork Adds

This fork carries compatibility patches that make the **stock upstream Cap web
image** work when self-hosted on [Coolify](https://coolify.io/docs/services/cap)
with [Cloudflare R2](https://developers.cloudflare.com/r2/) as the S3-compatible
object store.

### Problems Solved

| Problem | Fix |
| --- | --- |
| Browser uploads to R2 stored wrong payload (form object instead of file) | Patches compiled upload code to use presigned `PUT` URLs and send the actual file body |
| `/.well-known/workflow` routes blocked by the self-hosted proxy | Allowlist added in `apps/web/proxy.ts` and via compiled-image patch |
| Video processing stuck at 0% — media server never called | Workflow dispatch patched to send `x-media-server-secret` header and `webhookSecret` body from `MEDIA_SERVER_WEBHOOK_SECRET` |
| Raw upload objects never cleaned up after processing | Added cleanup in `apps/web/app/api/webhooks/media-server/progress/route.ts` |
| OTP login race condition — session not ready after callback | Retry loop with `cache: "no-store"` in `apps/web/app/(org)/verify-otp/form.tsx` |
| Invite acceptance blocked by Stripe subscription gate | Patched compiled invite-accept handler to skip subscription check |
| Resend email sender not configurable per-address | Added `RESEND_FROM_EMAIL` env var (`packages/env/server.ts`, `packages/database/emails/config.ts`) |

### How It Works

Two deployment strategies are supported:

1. **Patched stock image (recommended)** — `infra/cap-web-stock-r2fix.Dockerfile`
   takes the official upstream image and applies
   `scripts/patch-official-cap-web-r2-put.mjs` at build time. This patches the
   compiled JavaScript in-place without requiring a full source build.

2. **Source build** — The source-level fixes in `apps/web/proxy.ts`,
   `apps/web/app/(org)/verify-otp/form.tsx`, and the email/env packages are
   applied directly when building from source.

### Key Files

| Path | Purpose |
| --- | --- |
| `infra/cap-web-stock-r2fix.Dockerfile` | Dockerfile that layers the patch onto the stock image |
| `scripts/patch-official-cap-web-r2-put.mjs` | Patch script applied during stock-image build |
| `infra/self-hosted-r2-workflow-fixes.md` | Detailed runbook: diagnostics, stuck-row recovery, build checklist |
| `.github/workflows/docker-build-stock-r2fix.yml` | CI workflow that builds and publishes the patched image to GHCR |
| `docker-compose.coolify.yml` | Coolify-ready compose file |

## Self-Hosting with Coolify + R2

### Prerequisites

- A [Coolify](https://coolify.io/docs/services/cap) instance
- A Cloudflare R2 bucket (or other S3-compatible store)
- A Resend API key (optional, for email login)

### Deploy

1. Push the `cap-web-stock-r2fix` image to your GHCR registry via the
   `Docker Build Stock R2 Fix` workflow, or pull
   `ghcr.io/neronlux/cap-web-stock-r2fix:latest`.
2. In Coolify, use `docker-compose.coolify.yml` as the compose source (swap
   MinIO for your R2 endpoint).
3. Configure environment variables:

```bash
WEB_URL=https://cap.yourdomain.com
NEXTAUTH_URL=https://cap.yourdomain.com
NEXTAUTH_SECRET=<generate-a-secret>
DATABASE_ENCRYPTION_KEY=<generate-a-secret>
DATABASE_URL=mysql://cap:<password>@mysql:3306/cap

# R2 / S3
CAP_AWS_ACCESS_KEY=<r2-access-key-id>
CAP_AWS_SECRET_KEY=<r2-secret-access-key>
CAP_AWS_BUCKET=<bucket-name>
CAP_AWS_REGION=auto
S3_PUBLIC_ENDPOINT=https://<bucket>.<account>.r2.cloudflarestorage.com
S3_INTERNAL_ENDPOINT=https://<bucket>.<account>.r2.cloudflarestorage.com

# Media server
MEDIA_SERVER_URL=http://media-server:3456
MEDIA_SERVER_WEBHOOK_SECRET=<shared-secret>
MEDIA_SERVER_WEBHOOK_URL=http://cap-web:3000

# Email (optional)
RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM_DOMAIN=yourdomain.com
RESEND_FROM_EMAIL=Cap <cap@yourdomain.com>
```

4. Verify the patches are active inside the running container:

```sh
docker exec cap-web sh -lc 'node -e "
const fs = require(\"fs\");
const proxy = fs.readFileSync(\"/app/apps/web/.next/server/middleware.js\", \"utf8\");
const step = fs.readFileSync(\"/app/apps/web/.next/server/app/.well-known/workflow/v1/step/route.js\", \"utf8\");
console.log(\"proxyPatch=\" + proxy.includes(\"/.well-known/workflow\"));
console.log(\"workflowHeaderPatch=\" + step.includes(\"x-media-server-secret\"));
console.log(\"workflowBodyPatch=\" + step.includes(\"webhookSecret:process.env.MEDIA_SERVER_WEBHOOK_SECRET||void 0\"));
"'
```

All three should report `true`.

### Diagnostics

See [infra/self-hosted-r2-workflow-fixes.md](infra/self-hosted-r2-workflow-fixes.md)
for stuck-row recovery, stuck processing diagnosis, and the full build/deploy
checklist.

## Upstream Cap

Cap is the open source alternative to Loom — beautiful, shareable screen
recordings built for teams that want to own their data.

- **Record, edit, share.** Screen, camera, and microphone capture with instant
  share links or polished exports.
- **Instant Mode.** Upload while recording, share link on stop.
- **Studio Mode.** Local editing with backgrounds, zooms, trimming, captions.
- **Desktop apps.** macOS and Windows with a web dashboard for management.
- **Own your storage.** S3, R2, MinIO, Backblaze B2, Wasabi, or local.
- **Self-host.** Full platform with Docker Compose.
- **Docs.** [cap.so/docs](https://cap.so/docs)

## Local Development

Cap is a Turborepo monorepo with Rust, TypeScript, Tauri, SolidStart, Next.js,
Drizzle, MySQL, Tailwind CSS, and shared media crates.

Requirements:

- Node.js 20 or newer
- pnpm 10.5.2
- Rust 1.88 or newer
- Docker for MySQL, MinIO, and local services

```bash
pnpm install
pnpm env-setup
pnpm cap-setup
```

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the full local development stack |
| `pnpm dev:web` | Start the web app without the desktop app |
| `pnpm dev:desktop` | Start the desktop app |
| `pnpm build` | Build the workspace |
| `pnpm lint` | Run Biome linting |
| `pnpm typecheck` | Run TypeScript project references |
| `pnpm db:generate` | Generate database artifacts |
| `pnpm db:push` | Push schema changes |

## License

This fork inherits the same license as the upstream Cap project. All original
license terms apply without modification.

- **AGPLv3** — All code not mentioned below. See [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE).
- **MIT** — Code in the `cap-camera*` and `scap-*` crate families. See [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT).
- **Third-party** — Licensed under the original license provided by their owner.

Cap is copyright (c) 2023-present Cap Software, Inc. This fork's additional
changes are provided under the same AGPLv3 terms.

For contributing to Cap itself, see the [upstream repo](https://github.com/CapSoftware/Cap)
and [CONTRIBUTING.md](https://github.com/CapSoftware/Cap/blob/main/CONTRIBUTING.md).
