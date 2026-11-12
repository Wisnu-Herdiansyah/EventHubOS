# ADR-0053: Container images

- Status: accepted
- Date: 2026-11-12
- Builds on: ADR-0051 (Google Cloud, Cloud Run), ADR-0052 (Singapore)

## Decision

All four services ship as container images, built from one `Dockerfile` at the repository root,
with one target per service:

| Target   | Runs                                               | Port | Notes                                                       |
| -------- | -------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `api`    | `node apps/api/src/main.ts`                        | 8080 | Also runs the database bootstrap and migrations (see below) |
| `worker` | `node apps/worker/src/main.ts`                     | —    | No HTTP; stops cleanly on SIGTERM                           |
| `admin`  | Next.js standalone server (`apps/admin/server.js`) | 8080 |                                                             |
| `site`   | Next.js standalone server (`apps/site/server.js`)  | 8080 |                                                             |

### How they are built

- **Base image.** Node 22 on Debian 12 slim, from Google's Docker Hub mirror
  (`mirror.gcr.io`), **pinned by digest**. The mirror avoids Docker Hub's anonymous rate limits
  and suits Google Cloud.
- **Dependencies.** pnpm (the pinned version) fetches the lockfile's packages into a cache, and
  each image then installs only its own dependencies from it (`--frozen-lockfile --offline`).
  - The API and worker run their TypeScript sources directly, as in development, so their images
    keep the workspace layout with production dependencies only.
  - The admin and site use Next.js standalone output, a traced, self-contained server. It is
    switched on only inside the image build (`NEXT_OUTPUT=standalone`), so local development and
    the e2e harness are unchanged.
- **Behind a TLS-inspecting proxy,** pass the proxy as a build argument and its CA as a build
  secret: `--build-arg HTTPS_PROXY=… --secret id=extra_ca,src=proxy-ca.pem`. The CA is used only by
  the download steps and is never stored in a layer.

### What is in a runtime image

- **Only `node` and the service.** npm, Corepack and Yarn, which ship in the Node image, are
  removed. They are not used at run time, and they carried 10 known HIGH vulnerabilities.
- **The unprivileged `node` user** (uid 1000). Files are owned by root, so the service cannot
  change its own code.
- **No configuration and no secrets.** Everything comes from the environment at run time: Secret
  Manager on Cloud Run (ADR-0051). Defaults set in the image: `NODE_ENV=production`; for the API,
  `HTTP_HOST=0.0.0.0` and `HTTP_PORT=8080`; for the Next.js apps, `HOSTNAME=0.0.0.0` and
  `PORT=8080`.
- **Health checks.** The API checks `/health/live` and the admin its sign-in page. Docker uses
  these; Cloud Run uses its own probes against the same paths.

### Database jobs

The API image contains the database command-line tools, so a Cloud Run job can run them with the
migrator's credentials:

```
node packages/db/src/cli/bootstrap.ts   # once per environment
node packages/db/src/cli/migrate.ts     # every release, before new services start
```

### Checks in CI (`container images` job)

1. Build all four targets.
2. Run `scripts/container-smoke.sh` against a fresh PostgreSQL 16:
   - every image runs as a non-root user;
   - bootstrap and all migrations run from the API image;
   - the API is live and ready, and the worker starts;
   - the API and worker exit 0 on SIGTERM;
   - with a published port and the default 8080, the API, admin and site answer from outside the
     container, so they bind all interfaces as Cloud Run needs;
   - the admin serves its sign-in page with a CSP header, and its static files;
   - the site answers an unknown organization with a plain 404, and serves its static files.
3. Scan every image with Trivy (digest-pinned). The job fails on any HIGH or CRITICAL
   vulnerability that has a fix available.

These checks were mutation-tested: running as root, binding to localhost, a wrong default port,
missing static files and keeping npm in the image are each caught (7 of 7).

## Not done here

- **Pushing to Artifact Registry and deploying to Cloud Run.** Both need the staging project in
  Singapore, which does not exist yet. The project, billing and domain identifiers come from the
  product owner and are not invented here. The registry would be
  `asia-southeast1-docker.pkg.dev/<project>/eventhub`.
- **Image signing and provenance attestations.** These come with the registry.

## Alternatives

- **Distroless or Alpine base images.** Distroless has no shell, which makes the smoke test and
  operational debugging harder. Alpine (musl) needs separate native builds for sharp and argon2.
  Debian slim, with the package managers removed, gives a clean scan with the prebuilt binaries the
  code is tested with.
- **Bundling the API and worker into JavaScript.** It would add a build step that development does
  not have, so the code that runs would differ from the code that is tested.
- **`pnpm deploy` for the API and worker.** It copies workspace packages into `node_modules`, where
  Node does not strip TypeScript types, so they would need a build step after all.
- **Cloud Buildpacks.** Less control over users, files and the base image, and harder to check in
  CI.
