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
	 |
	<a href="https://cap.so/pricing">Pricing</a>
</p>

---

This is a personal fork of [Cap](https://github.com/CapSoftware/Cap) maintained by [@neronlux](https://github.com/neronlux). It is **not** affiliated with Cap Software.

The upstream Cap project is the open source alternative to Loom — beautiful, shareable screen recordings built for teams that want to own their data.

## What This Fork Adds

This fork carries compatibility patches that make the **stock upstream Cap web image** work correctly when self-hosted on [Coolify](https://coolify.io/) with [Cloudflare R2](https://developers.cloudflare.com/r2/) as the S3-compatible object store.

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

1. **Patched stock image (recommended)** — `infra/cap-web-stock-r2fix.Dockerfile` takes the official `ghcr.io/capsoftware/cap-web:latest` image and applies `scripts/patch-official-cap-web-r2-put.mjs` at build time. This patches the compiled JavaScript in-place without requiring a full source build.

2. **Source build** — The source-level fixes in `apps/web/proxy.ts`, `apps/web/app/(org)/verify-otp/form.tsx`, and the email/env packages are applied directly when building from source.

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

- A [Coolify](https://coolify.io/) instance
- A Cloudflare R2 bucket (or other S3-compatible store)
- A Resend API key (optional, for email login)

### Deploy

1. Push the `cap-web-stock-r2fix` image to your GHCR registry via the `Docker Build Stock R2 Fix` workflow, or pull `ghcr.io/neronlux/cap-web-stock-r2fix:latest`.
2. In Coolify, use `docker-compose.coolify.yml` as the compose source (swap MinIO for your R2 endpoint).
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

See [infra/self-hosted-r2-workflow-fixes.md](infra/self-hosted-r2-workflow-fixes.md) for:
- Diagnosing stuck processing rows
- Recovering stale uploads
- Build and deploy checklist

## Upstream Documentation

The sections below are from the upstream Cap project. They apply to this fork unless noted otherwise.

<details>
<summary><strong>Recording Modes, Data Ownership, Get Started</strong></summary>

### Recording Modes

| Mode | Best for | How it works |
| --- | --- | --- |
| Instant Mode | Fast feedback, bug reports, async updates | Cap uploads while you record, then gives you a share link as soon as recording stops. |
| Studio Mode | Product demos, tutorials, launches, client work | Cap records locally, opens the editor, and lets you export or share a polished video. |

### Data Ownership

- Connect Cloudflare R2, AWS S3, Backblaze B2, MinIO, Wasabi, or another S3-compatible provider.
- Serve share pages from your own domain.
- Self-host Cap Web, the API, database, media server, and object storage with Docker Compose.
- Point Cap Desktop at your self-hosted instance from `Settings > Cap Server URL`.

### Get Started (hosted)

1. Download Cap for macOS or Windows from [cap.so/download](https://cap.so/download).
2. Sign in or create an account.
3. Choose Instant Mode or Studio Mode.
4. Record your first Cap.
5. Share the link, export the file, or keep it local.

</details>

## Local Development

Cap is a Turborepo monorepo with Rust, TypeScript, Tauri, SolidStart, Next.js, Drizzle, MySQL, Tailwind CSS, and shared media crates.

Requirements:

- Node.js 20 or newer
- pnpm 10.5.2
- Rust 1.88 or newer
- Docker for MySQL, MinIO, and local services

Install and set up the repo:

```bash
pnpm install
pnpm env-setup
pnpm cap-setup
```

Common commands:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the full local development stack |
| `pnpm dev:web` | Start the web app without the desktop app |
| `pnpm dev:desktop` | Start the desktop app |
| `pnpm build` | Build the workspace |
| `pnpm tauri:build` | Build the desktop release |
| `pnpm lint` | Run Biome linting |
| `pnpm format` | Format with Biome |
| `pnpm typecheck` | Run TypeScript project references |
| `cargo test -p <crate>` | Run Rust tests for a crate |

Database commands:

| Command | Purpose |
| --- | --- |
| `pnpm db:generate` | Generate database artifacts |
| `pnpm db:push` | Push schema changes |
| `pnpm db:studio` | Open Drizzle Studio |

## Repository Map

| Path | What lives there |
| --- | --- |
| `apps/desktop` | Tauri v2 desktop app with SolidStart UI and Rust backend |
| `apps/web` | Next.js web app for marketing, docs, dashboard, sharing, API routes, and auth |
| `apps/cli` | Rust CLI |
| `apps/media-server` | Media processing service used by the web app |
| `apps/discord-bot` | Discord integration |
| `packages/database` | Drizzle schema and database access |
| `packages/ui` | Shared React UI |
| `packages/ui-solid` | Shared Solid UI |
| `packages/web-backend` | Backend service layer |
| `packages/web-domain` | Web domain models and types |
| `packages/env` | Environment validation |
| `packages/sdk-embed` | Embed SDK |
| `packages/sdk-recorder` | Recorder SDK |
| `crates/*` | Recording, capture, camera, audio, encoding, rendering, muxing, export, and test crates |
| `scripts/*` | Setup, analytics, build, and maintenance tooling |
| `infra/*` | Infrastructure configuration |

The web API uses Effect and `@effect/platform` HTTP APIs. Desktop capture and export paths are backed by Rust crates for fast recording, rendering, and platform-specific media access.

## Contributing

This is a personal-use fork. For contributing to Cap itself, see the [upstream repo](https://github.com/CapSoftware/Cap) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Portions of this software are licensed as follows:

- Code in the `cap-camera*` and `scap-*` crate families is licensed under the MIT License. See [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT).
- Third-party components are licensed under the original license provided by their owner.
- All other content not mentioned above is available under the AGPLv3 license as defined in [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE).
