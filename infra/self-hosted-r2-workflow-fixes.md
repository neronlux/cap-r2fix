# Self-Hosted R2 Workflow Fixes

This fork carries compatibility patches for running the stock Cap web image in a
Coolify/self-hosted deployment with Cloudflare R2 or another S3-compatible
backend.

The fixes are applied by `scripts/patch-official-cap-web-r2-put.mjs` during the
stock-image build. Keep this runbook with that script; the deployed image can be
rebuilt from the repo without redoing manual container edits.

## Why These Patches Exist

The upstream stock image assumes hosted workflow and upload behavior that does
not fully match this self-hosted setup.

Observed failures:

- Browser uploads to R2 could store the wrong payload when compiled upload code
  sent the form/resolve object instead of the actual file.
- The local workflow queue could silently treat the login page as a successful
  workflow response because `/.well-known/workflow/...` was not allowed through
  the self-hosted proxy.
- File-import processing could stay at `processing 0%` because the compiled
  workflow step called `POST /video/process` without the media-server secret.
- Existing stuck rows did not recover automatically once the code was patched;
  they needed a one-time retry or row reset.

## Patch Summary

`scripts/patch-official-cap-web-r2-put.mjs` patches the compiled stock image to:

- use presigned `PUT` URLs for S3-compatible uploads;
- send the actual file body for web upload chunks;
- serialize local workflow queue request bodies as text;
- allow `/.well-known/workflow` through the self-hosted proxy;
- send `x-media-server-secret` and `webhookSecret` from
  `MEDIA_SERVER_WEBHOOK_SECRET` when workflow processing calls the media server;
- preserve the Resend sender override, OTP retry behavior, and self-hosted invite
  acceptance patches.

The source-level proxy fix lives in `apps/web/proxy.ts` so source builds also
allow workflow routes in self-hosted mode.

## Required Runtime Configuration

The `cap-web` and `cap-media-server` containers must agree on:

- `MEDIA_SERVER_URL`
- `MEDIA_SERVER_WEBHOOK_URL` or `WEB_URL`
- `MEDIA_SERVER_WEBHOOK_SECRET`
- S3/R2 endpoint, bucket, region, access key, and secret key environment values

Never log or commit the actual secret values. To compare the web and media
server webhook secret, check whether both are set and whether their values are
equal without printing the values.

## How To Verify The Live Image

After pulling/recreating the stock image, verify the compiled patches inside the
web container:

```sh
docker exec cap-web-<service-id> sh -lc 'node -e "
const fs = require(\"fs\");
const proxy = fs.readFileSync(\"/app/apps/web/.next/server/middleware.js\", \"utf8\");
const step = fs.readFileSync(\"/app/apps/web/.next/server/app/.well-known/workflow/v1/step/route.js\", \"utf8\");
console.log(\"proxyPatch=\" + proxy.includes(\"/.well-known/workflow\"));
console.log(\"workflowHeaderPatch=\" + step.includes(\"x-media-server-secret\"));
console.log(\"workflowBodyPatch=\" + step.includes(\"webhookSecret:process.env.MEDIA_SERVER_WEBHOOK_SECRET||void 0\"));
"'
```

Expected result:

```text
proxyPatch=true
workflowHeaderPatch=true
workflowBodyPatch=true
```

Also confirm no upload rows are stuck:

```sh
docker exec cap-db-<service-id> sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -N -B -e "SELECT COUNT(*) FROM video_uploads;"'
```

## Diagnosing Stuck Processing

Start with database state:

```sql
SELECT
  vu.video_id,
  v.name,
  vu.started_at,
  vu.updated_at,
  TIMESTAMPDIFF(SECOND, vu.updated_at, NOW()) AS seconds_since_update,
  vu.phase,
  vu.processing_progress,
  vu.processing_message,
  vu.processing_error,
  vu.raw_file_key,
  v.duration,
  v.width,
  v.height,
  v.fps
FROM video_uploads vu
LEFT JOIN videos v ON v.id = vu.video_id
ORDER BY vu.started_at DESC
LIMIT 10;
```

Then compare logs:

- Web logs with `Workflow`, `media-server-webhook`, `Unauthorized`, or
  `Failed to queue` show whether the workflow and webhook paths are moving.
- Media-server logs with `POST /video/process` show whether the media server was
  called and whether it returned `200` or `401`.

Failure interpretation:

- `processing 0%` with no media-server request: workflow route/queue did not
  dispatch.
- `POST /video/process 401`: web and media server auth headers/body are missing
  or secret values do not match.
- `processing 80%` with later `generating_thumbnail` and `complete` webhooks:
  wait for completion; larger files can spend time uploading.
- `video_uploads` row disappears and the `videos` row has duration/size metadata:
  processing completed.

## Recovering A Stale Row

For a stale row that failed before the current image was patched, retry the media
server job after verifying that the raw upload object still exists. The retry
must generate fresh internal signed URLs from the web container's S3/R2 env and
call the media server with `x-media-server-secret`.

If the media server sends a `complete` webhook, the web app updates video
metadata and deletes the `video_uploads` row. If the raw object is gone or the
video row was deleted, mark the upload as errored rather than retrying.

## Build And Deploy Checklist

1. Run `node --check scripts/patch-official-cap-web-r2-put.mjs`.
2. Run `git diff --check`.
3. Commit and push the patch.
4. Confirm `Docker Build Stock R2 Fix` succeeds.
5. Pull/recreate `cap-web` in Coolify.
6. Verify `proxyPatch`, `workflowHeaderPatch`, and `workflowBodyPatch` are all
   `true`.
7. Upload a fresh video and confirm `video_uploads` clears after processing.
