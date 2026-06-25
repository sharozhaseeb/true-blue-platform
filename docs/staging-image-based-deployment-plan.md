# Staging Image-Based Deployment Plan

## Purpose

This document defines the safe path for moving staging from **source-build deployment on EC2** to **image-based deployment**.

The goal is to eliminate the current failure mode where the EC2 host stalls or becomes unreachable during `docker compose build`, while preserving:

- reproducible builds
- explicit migration control
- rollback capability
- staging verification strong enough for client retest

This plan is intentionally detailed. If any step is unclear, treat that as a documentation defect and fix the doc before using the process.

## Current Problem

The current staging contract is:

- EC2 instance: `t3.small` (`2 vCPU / 2 GB RAM`)
- single host runs `db`, `app`, and `nginx`
- deployment flow uses `git pull` plus `docker compose build --no-cache`
- `app` and `migrate` are both built on the server from source

This is fragile for this repo because the build path includes:

- `npm ci`
- native toolchain install (`python3`, `make`, `g++`)
- `npx prisma generate`
- `npm run build`

On the current server size, that can exhaust memory, saturate CPU, fill disk with image layers, and leave the host unresponsive during deployment.

## Decision

The deployment model must change from:

- **source-based deploy**: `git pull` -> `docker compose build` on EC2

to:

- **image-based deploy**: build images off-box -> publish immutable images -> EC2 pulls/runs images only

This is the only recommended model going forward.

## Recommended Target State

### Runtime contract

Staging should do all of the following:

- run `db`, `app`, `nginx`
- run `migrate` only as a one-shot deployment step
- never run `docker compose build` during a normal deploy
- consume immutable image tags for both `app` and `migrate`

### Build contract

Builds should happen:

- on a developer machine as a temporary controlled process, or
- in CI as the long-term target

Build artifacts must be:

- Linux-compatible
- architecture-pinned to `linux/amd64`
- tagged with an immutable identifier, preferably the Git commit SHA

### Infrastructure recommendation

If image-based deploy is adopted:

- minimum acceptable staging size: `t3.medium`
- preferred safer size: `t3.large`

If source-based deploy continues for any reason:

- `t3.large` is the minimum practical size
- source-based deploy should still be treated as a temporary exception, not the standard

## Non-Negotiable Rules

1. Do not use `docker compose build` on staging during routine deploys.
2. Do not use floating image tags such as `latest` for deploys.
3. Do not deploy an `app` image and `migrate` image from different source revisions.
4. Do not run schema migrations without a rollback plan and a verification step.
5. Do not ask the client to retest until staging verification and evidence collection are complete.

## Step-by-Step Plan

## Phase 0 - Preconditions

### Step 0.1 - Recover and stabilize staging host

Before changing deployment flow:

- confirm the EC2 instance is reachable
- confirm Docker and disk are healthy
- confirm available free disk is enough for existing images and one additional release
- confirm the current services can start and stop cleanly

### Step 0.1a - Preserve Compose project identity

Current repo risk:

- Docker Compose currently relies on the working directory identity for project-scoped resources
- PostgreSQL uses the named volume `pgdata`
- nginx uses a relative bind mount to `./nginx/nginx.conf`

If the deployment runs from a different directory or a different Compose project name, staging can accidentally:

- attach a fresh empty Postgres volume
- lose the intended nginx config file path

Handling:

- keep the deployment rooted in the same server path unless and until Compose naming is pinned explicitly
- discover the current implicit Compose project name and the current backing volume names before changing anything
- for the first cutover, either:
  1. set `COMPOSE_PROJECT_NAME` to the existing live project name, or
  2. externalize and explicitly name the current Postgres volume before changing project naming
- only after that, set and document a fixed `COMPOSE_PROJECT_NAME`
- before the first cutover, verify that the image-based flow still resolves the existing Postgres volume and nginx config path

### Step 0.2 - Right-size the host

Recommended action:

- resize staging from `t3.small` to at least `t3.medium`

Why:

- off-box builds remove the worst CPU/RAM spike
- but runtime still includes Next.js, PostgreSQL, nginx, uploads, PDF processing, and Docker overhead

If the team wants more operational safety:

- use `t3.large`

### Step 0.3 - Add swap as protection, not as the solution

Recommended short-term protection:

- configure a 2-4 GB swap file on staging

This is not the architectural fix. It only reduces the chance that the box hard-locks under transient pressure.

### Step 0.4 - Capture baseline operations data

Record before changing the process:

- current instance type
- current free disk
- current Docker image usage
- current running container list
- current home page response
- current authenticated login result
- current representative authenticated API result

This becomes the comparison point if the new process behaves unexpectedly.

### Step 0.5 - Add a real pre-migration backup point

Current repo risk:

- the database is local Docker state
- `migrate` runs both `prisma migrate deploy` and `prisma db seed`
- restoring old images does not restore old schema or old data

Required handling:

- create a database backup before running migrations for every deploy that includes schema changes
- store the backup with a release identifier and timestamp
- document the exact restore command path before approving the deploy

The rollback plan is incomplete without this step.

### Step 0.6 - Verify Docker Hub readiness before changing deploy flow

Current repo risk:

- a local Docker Hub account alone does not prove staging can pull the release images
- the near-term deployment path depends on both local push access and server-side pull access

Required checks:

- confirm the local build environment can authenticate and push to the chosen `app` and `migrate` repositories
- if the repositories are private, confirm the staging execution user (`ec2-user`) can authenticate to Docker Hub
- confirm `ec2-user` can pull both release images successfully from staging
- confirm the server `.env` file can carry `APP_IMAGE` and `MIGRATE_IMAGE` cleanly
- confirm the server has enough free disk for one new release plus one rollback release

Do not start the image-based cutover until these checks are complete.

## Phase 1 - Convert Compose from Build-Based to Image-Based

### Step 1.1 - Change `docker-compose.prod.yml`

Current risk:

- `app` and `migrate` both use `build:`
- this invites accidental server-side rebuilds

Required change:

- replace `build:` in `app` with an explicit image reference
- replace `build:` in `migrate` with an explicit image reference

Recommended shape:

- `app` uses `image: ${APP_IMAGE}`
- `migrate` uses `image: ${MIGRATE_IMAGE}`

Source-of-truth rule for this repo:

- the server-side repo root `.env` file is the deploy-time source of truth for `APP_IMAGE` and `MIGRATE_IMAGE`
- `.env.staging` must be updated to include those keys in the template
- deployment updates those two keys in `.env` before any `docker compose pull` or `docker compose up`
- do not rely on ad hoc shell exports as the normal deployment path

### Step 1.2 - Keep app and migrate version-locked

Risk:

- app and migrate built from different commits can produce schema/runtime mismatch

Handling:

- both images must use the same release tag
- the tag must be commit-specific

Example:

- `APP_IMAGE=...:app-<gitsha>`
- `MIGRATE_IMAGE=...:migrate-<gitsha>`

### Step 1.3 - Decide how nginx config is delivered

Current state:

- `nginx` mounts `./nginx/nginx.conf` from the repo

Risk:

- if only images are deployed, nginx config changes may not reach staging

Two acceptable options:

1. **Short-term**: keep the bind mount and explicitly sync `nginx/nginx.conf` with every deploy that changes it.
2. **Long-term preferred**: build a small custom nginx image that contains the config.

Recommendation:

- use option 1 first if speed matters
- move to option 2 once the image-based flow is stable

### Step 1.4 - Make the docs reject server-side rebuilds

Risk:

- an operator follows old docs and accidentally runs `docker compose build --no-cache` on staging again

Handling:

- update deployment docs immediately after compose changes
- remove or clearly deprecate all build-on-server instructions
- replace them with image pull/load instructions only

### Step 1.5 - Pin core runtime images as part of the release contract

Current repo risk:

- `db` and `nginx` still use floating upstream tags in Compose

That means later pulls can change staging outside the release SHA even if `app` and `migrate` are pinned.

Handling:

- pin `db` and `nginx` to exact tags or digests
- record those versions in release notes alongside `APP_IMAGE` and `MIGRATE_IMAGE`

## Phase 2 - Define the Build Artifacts

### Step 2.1 - Build both required images

This repo needs at least two deployable artifacts:

- `app` image from the `runner` target
- `migrate` image from the `builder` target, or a dedicated migration target if one is later added

Risk:

- deploying only the app image leaves migrations unsupported

Handling:

- always build and publish both images together

### Step 2.2 - Pin platform explicitly

Risk:

- local builds from Windows or ARM hosts can produce an image that fails on EC2 Linux x86_64

Handling:

- always build with `--platform linux/amd64`

### Step 2.3 - Tag images immutably

Risk:

- mutable tags make rollback and incident review unreliable

Handling:

- tag with commit SHA
- optionally add a human-readable release alias in addition to the SHA tag

Required rule:

- the SHA tag is the source of truth

### Step 2.4 - Smoke-test images before publishing

Before an image leaves the build environment:

- run typecheck
- run production build
- run local verifier suite
- run a local container smoke test if the deployment changes touched infra or runtime wiring

The build artifact must not be promoted to staging without this gate.

### Step 2.5 - Replace the old smoke-test harness explicitly

Current repo risk:

- `scripts/test-build.sh` currently depends on a production Compose file that builds from source

After the Compose conversion, the smoke gate must still exist in a concrete form.

Required handling:

- either update `scripts/test-build.sh` to accept `APP_IMAGE` and `MIGRATE_IMAGE`
- or create a dedicated image-based smoke-test Compose file for local validation

The replacement harness must prove all of the following before an image is promoted:

- the `app` image starts successfully
- the `migrate` image can run Prisma commands successfully
- the image pair works together against a disposable Postgres container

## Phase 3 - Choose the Artifact Transport Mechanism

### Recommended near-term path - Docker Hub registry

This is the lowest-impact stable change for the current team and repo.

Why:

- it avoids server-side builds immediately
- it does not require AWS registry/IAM work before the next deploy
- it preserves the current EC2 + Docker Compose runtime model
- it lets the team stabilize the image-based process first, then improve the registry later

Required handling:

- create the `app` and `migrate` repositories
- if the repositories are private, authenticate the staging execution user (`ec2-user` in the current manual SSH workflow) with a Docker Hub account or token that can pull those images
- use immutable tags for every release
- record the exact pushed tags in deployment notes
- if the repositories are private, run deploy commands as the same user that performed `docker login` on staging
- update `APP_IMAGE` and `MIGRATE_IMAGE` in the server `.env` file before pulling
- use `docker compose pull app migrate` only after those values are updated
- record the resolved pulled image digests in release notes after the pull succeeds

Known risks:

- deploys depend on Docker Hub availability
- the staging host must store and rotate Docker Hub credentials
- pull access and account limits must be understood before relying on automated deploys
- each release must pull both the `app` image and the larger `migrate` image, which increases disk pressure on staging

### Preferred long-term path - ECR registry-based deployment

Recommended long-term transport once the low-impact path is stable:

- use ECR

Why:

- avoids large tarball copies
- keeps rollback images available
- makes tags and history easier to manage
- reduces manual operator steps

Required work:

- create repository for app image
- create repository for migrate image
- authenticate local/CI builder to ECR
- authenticate staging host to ECR pull
- attach the required ECR pull permissions to the staging EC2 instance profile
- define separate push permissions for the build environment

Without explicit ECR IAM work, this path is not deployable for the current AWS setup today.

### Temporary fallback - `docker save` / `docker load`

Acceptable only as an interim measure if registry setup is blocked.

Risk:

- large tarballs consume local and remote disk
- manual transfer is slower and more error-prone
- rollback requires storing previous tarballs or leaving old images on the box

Handling:

- use immutable tags
- verify free disk before copying
- delete stale tarballs after successful load
- keep at least one previous release image on the server until the new release is verified

## Phase 4 - Deployment Procedure

This section defines the release sequence.

### Step 4.1 - Record current release before changing anything

Capture:

- running image IDs for `app`
- current `APP_IMAGE` and `MIGRATE_IMAGE` values
- current migration state
- current home page response
- current login response
- current representative authenticated API response
- current pinned `db` and `nginx` image versions

Risk:

- no clear rollback point

Handling:

- save this information with the deployment notes for the release

### Step 4.2 - Update deploy-time image references first

Set the exact new values for:

- `APP_IMAGE`
- `MIGRATE_IMAGE`

Risk:

- partial update causes mixed-version release
- stale values cause Compose to pull the wrong images

Handling:

- update both together in the server `.env` file in one deploy step
- verify the resolved image names before running any pull command by checking:
  - `grep -E '^(APP_IMAGE|MIGRATE_IMAGE)=' .env`
  - `docker compose config | grep 'image:'`

### Step 4.3 - Stage the new images on the server

If using registry:

- run `docker compose pull app migrate` only after `.env` contains the intended tags
- record the resulting image digests after the pull succeeds

If using tarball fallback:

- copy both tarballs
- load both images
- verify the image tags exist locally

### Step 4.2a - Quiesce upload traffic before restart or migration

Current repo risk:

- the app startup sweeper can mark stale `UPLOADING` or `PROCESSING` documents as `FAILED`
- restarting the app while uploads are active can therefore create visible data-loss-style behavior during acceptance testing

Required handling before restart:

- stop or pause external testing traffic
- verify no documents are currently in `UPLOADING` or `PROCESSING`
- proceed only when the upload pipeline is idle

### Step 4.4 - Take the pre-migration database backup

If the release contains schema changes or data-affecting seed changes:

- create the database backup immediately before migration
- record the exact backup artifact path in release notes
- verify that the backup file exists before continuing

Do not continue to migration until this step is complete.

### Step 4.5 - Run migrations before replacing app traffic

Run the one-shot `migrate` container using the new migration image.

Risk:

- app starts against old schema

Handling:

- do not leave the old app serving traffic during a non-backward-compatible migration
- choose one of these two strategies explicitly for each deploy:
  1. accept controlled downtime and stop `app` before migration
  2. require expand/contract-compatible migrations so old and new app versions can both operate during cutover
- record which strategy the release is using in deployment notes
- deploy the new app only after migration succeeds

### Step 4.6 - Seed behavior must remain idempotent

Current state:

- `prisma/seed.ts` uses `upsert`, which is compatible with repeat execution

Risk:

- future seed changes may become non-idempotent and duplicate or mutate data

Handling:

- keep seed idempotent
- treat any seed change as deploy-sensitive
- if seed ever becomes non-idempotent, separate seeding from normal deploys

### Step 4.7 - Start the new app release

After migration succeeds:

- start or recreate `app`
- ensure health check passes
- restart `nginx` only if required

### Step 4.8 - Verify runtime

Required immediate checks:

- `docker compose ps`
- homepage response
- login request using a real test account
- representative authenticated API call
- one document upload path smoke check if the release affects M2 pipeline/runtime
- one document delete smoke check if the release touches M2 document handling

Do not rely on `/` alone as proof that staging is healthy. In this repo, landing-page success does not prove database auth, S3 access, or document pipeline health.

## Phase 5 - Verification and Release Evidence

### Step 5.1 - Collect staging evidence

For a release that affects M2 extraction, chunking, or metadata:

- rerun the exact client repro cases
- rerun the M2 acceptance flow
- save concrete evidence, not just pass/fail statements

### Step 5.2 - Update release notes

For every staging deployment, save:

- release tag / commit SHA
- date and operator
- images deployed
- migration result
- health verification result
- rollback image/tag
- any follow-up issues

## Phase 6 - Rollback Procedure

### Rollback rule

Rollback must be possible without rebuilding on the server.

### Rollback steps

1. Stop rollout activity.
2. Restore previous `APP_IMAGE` and `MIGRATE_IMAGE` references.
3. Recreate the `app` service using the previous app image.
4. Restart `nginx` if needed.
5. Verify health and critical flows.

### Database restore procedure

If the failed release included a migration that cannot be safely rolled forward or tolerated:

1. stop the application services
2. restore the pre-migration database backup
3. restore previous image references
4. recreate `app`
5. verify login and critical document flows

Image rollback without a DB restore is not a real rollback when schema or seed state changed.

### Important caveat - database migrations

Risk:

- schema migrations are often not safely reversible

Handling:

- migrations must be designed to be backward-compatible where possible
- destructive migrations must have a separate explicit rollback plan
- if a migration cannot be rolled back, deploy approval must acknowledge that risk before rollout

This is the single biggest operational risk in the whole process.

## Issue Register and Handling

## 1. EC2 still too small at runtime

Issue:

- moving builds off-box removes build pressure, not runtime pressure

Handling:

- resize to at least `t3.medium`
- use `t3.large` if upload and PDF processing continue to pressure memory
- add swap and monitoring

## 2. Server accidentally rebuilt from source again

Issue:

- old habits or old docs trigger `docker compose build`

Handling:

- remove `build:` from production compose
- update docs
- treat any source build on staging as a process violation

## 3. App and migrate images do not match

Issue:

- schema/runtime mismatch

Handling:

- one immutable tag family per release
- do not deploy partial image sets

## 4. Wrong architecture image

Issue:

- image builds on wrong platform and fails on EC2

Handling:

- always build `linux/amd64`
- verify architecture before publish

## 5. Prisma engine incompatibility

Issue:

- Prisma native engine or OpenSSL mismatch causes runtime or migration failure

Handling:

- keep Docker runtime base aligned with the Prisma binary target contract already used in the repo
- smoke-test the actual built images before publish

## 6. Migration succeeds locally but fails on staging

Issue:

- env differences, DB drift, permissions, or data shape differences

Handling:

- run migration as an explicit deployment step
- do not start new app version first
- keep rollback image references ready
- require a pre-migration DB backup
- choose downtime or expand/contract explicitly

## 7. Seed script mutates staging unexpectedly

Issue:

- non-idempotent seed logic can drift staging data

Handling:

- keep seed idempotent
- review seed changes separately
- split seeding from standard deploy if that guarantee stops being true

## 8. Nginx config drift

Issue:

- app release changes but nginx config on server does not

Handling:

- either sync `nginx/nginx.conf` explicitly every deploy that changes it
- or move nginx config into an image

## 9. Environment drift between build and runtime

Issue:

- build artifact may not match staging env expectations

Handling:

- define which env vars are runtime-only and which are build-sensitive
- document them
- use staging-specific build rules only when truly necessary

## 10. Docker Hub authentication or policy failure

Issue:

- the server cannot pull the private release images because Docker Hub auth, token storage, or account limits are wrong

Handling:

- authenticate the staging host explicitly before the first pull-only deploy
- use a dedicated token rather than a personal password
- run `docker login` and deployment commands as the same execution user on staging (`ec2-user` in the current manual SSH workflow)
- document where the token is stored and how it is rotated
- verify the host can pull both `app` and `migrate` images before the deployment window starts

## 11. Disk exhaustion during image load/pull

Issue:

 - staging has limited disk and Docker layers accumulate
 - each release pulls both the runtime app image and a separate migration image with Prisma tooling and dependencies

Handling:

- require a concrete free-space gate before a pull-only release:
  - if `/var/lib/docker` or the Docker root filesystem has less than `8 GB` free, stop the deploy and free space first
- prune stale images only after a known-good rollback image exists
- delete temporary tarballs after successful load

## 12. No rollback image available

Issue:

- failed release cannot be reverted quickly

Handling:

- keep previous release image available until new release is verified
- never overwrite rollback metadata with `latest`

## 13. Docs and actual process diverge

Issue:

- operators follow stale instructions

Handling:

- update docs and operational scripts in the same change set as the deployment conversion
- no process change is complete until the docs match the process

Required scope for this repo:

- `docs/deployment-guide.md`
- `docs/staging-notes.md`
- `scripts/test-build.sh`
- `.env.staging`

## 14. Client retest requested without staging evidence

Issue:

- product may be locally sound but not proven on staging

Handling:

- keep staging evidence as a release gate
- do not request client retest until the new release is verified in staging

## Implementation Order

The recommended order is:

1. Resize and stabilize staging host.
2. Update `docker-compose.prod.yml` to use image references.
3. Pin Compose project identity and core runtime image versions.
4. Update deployment docs and scripts to remove server-side builds.
5. Establish image tagging scheme.
6. Build both images off-box with `linux/amd64`.
7. Replace the old source-build smoke harness with an image-based verifier.
8. Prepare backup and rollback commands for the release.
9. Choose transport path:
   - Docker Hub private registry for the lowest-impact near-term path
   - ECR as the cleaner long-term AWS-native path
   - tarball fallback only if needed
10. Quiesce uploads and deploy images to staging using the new flow.
11. Take the pre-migration backup.
12. Run migration explicitly using downtime or an expand/contract-compatible path.
13. Verify login, authenticated API, and M2 document flows.
14. Mark the old build-on-server flow deprecated and unsupported.

## Exit Criteria

This plan is not complete until all of the following are true:

- staging deploy does not require `docker compose build`
- app and migrate use immutable image tags
- db and nginx image versions are pinned and recorded
- Compose project identity is preserved explicitly
- a rollback image/tag exists for the previous release
- a pre-migration DB backup exists for schema-changing deploys
- an image-based smoke-test harness exists and is used before promotion
- deployment docs match the new process
- staging verification is captured after deployment
- client retest readiness is based on staging proof, not local confidence

## Final Recommendation

The correct strategic move is:

- move to image-based deploy
- stop building on the staging host
- resize the host to at least `t3.medium`
- use Docker Hub first if the goal is the lowest-impact stable change
- move to ECR later if the team wants the cleaner AWS-native registry path

The near-term recommended low-impact path is:

- resize staging to `t3.medium`
- build `app` and `migrate` off-box
- push immutable tags to private Docker Hub repositories
- pull those images on staging
- run migration explicitly
- verify login, API, and M2 document flows

The temporary acceptable fallback below that is:

- build off-box
- transfer images with `docker save` / `docker load`
- but only while the team is actively moving toward registry-based deploys

Do not keep the current hybrid model where the team "usually" builds off-box but the server and docs still allow source builds. That leaves the main failure mode in place.
