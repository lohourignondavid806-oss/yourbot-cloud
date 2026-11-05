# OpenBot Docker deployment for YourBot

This directory prepares the first isolated VPS environment. It does not deploy anything.

## Image build path

The image is built only in GitHub Actions:

1. The workflow builds the Linux x64 AppImage with `bun run dist:linux`.
2. The build prepares the pinned provider runtimes and the x64 remote-desktop runtime.
3. `docker/Dockerfile` extracts the AppImage and installs its generated `packages.txt`.
4. The workflow starts the image with the official seccomp profile and runs the signed-out server smoke test.
5. The tested image is saved as an artifact.
6. GHCR publication is allowed only for a `v*` tag or for a manual run with `publish=true`.

The Dockerfile already provides the required runtime pieces:

- Ubuntu 24.04 base;
- Electron and Chromium runtime from the AppImage;
- Xvfb virtual displays;
- Computer Use runtime;
- provider runtime files;
- keyring support;
- non-root UID 1000;
- `tini` as PID 1.

No Boat credential is needed by the build or the container.

## First VPS environment

Before a future deployment, prepare a separate VPS directory and copy:

- `deploy/openbot/docker-compose.yml`;
- `deploy/openbot/.env.example` as `.env`;
- `docker/seccomp.json` at the path in `OPENBOT_SECCOMP_PROFILE` (the repository default is
  `../../docker/seccomp.json`; set it to `./seccomp.json` if the profile is copied beside the Compose file).

Set `OPENBOT_IMAGE` and an immutable `OPENBOT_TAG` from GHCR. The first environment uses one named
volume and one named bridge network. It publishes no port; OpenBot connects out through its account,
Signal, and TURN services.

The container deliberately does not receive:

- `BOAT_API_KEY`;
- `BOAT_WEBHOOK_SECRET`;
- `OPENBOT_HOSTED_SERVER`;
- the Docker socket;
- host filesystem mounts.

The persistent volume contains the OpenBot database, workspaces, browser profiles, provider sessions,
keyring, and logs. Treat backups of this volume as production secrets.

## Multi-tenant expansion

Create a separate Compose project, volume, network, and resource budget for each tenant. Do not reuse
the prototype volume. For stronger disk quotas, use the repository's official `docker/instances`
helper, which creates a bounded ext4 data image per instance. The helper also adds host firewall rules
and user namespace checks.

Docker containers share the host kernel. For mutually untrusted tenants, use one VM per tenant or a
dedicated host per trust group instead of relying on Docker alone.

## Boat independence

The self-hosted container uses `OPENBOT_SERVER=1` from `openbot-container`; it does not use the hosted
bootstrap or Boat sandbox lifecycle. YourBot must provide the missing control-plane functions:

- tenant-to-instance mapping;
- create/start/stop/delete operations;
- idle shutdown and wake;
- volume backup and restore;
- CPU, memory, PID, and storage admission control;
- status and event delivery to the YourBot interface.

The existing OpenBot Hosted Servers service remains Boat-specific. Reusing that UI unchanged would
require a provider adapter and schema/control-plane changes in `apps/auth-api`.

## Checks still required before deployment

- obtain the commercial OpenBot license for the YourBot SaaS;
- confirm provider terms for server-side credentials and OAuth;
- configure GHCR package visibility and a read-only VPS pull credential;
- validate the exact image tag with the workflow smoke test;
- validate login, agents, files, workspaces, browser, Computer Use, WebRTC, and remote desktop;
- validate backup/restore and graceful stop on the target Ubuntu x86_64 VPS;
- measure memory and CPU before enabling multiple tenants;
- test the custom Account API path separately if `OPENBOT_AUTH_API_URL` is used.

No Docker build, GHCR publication, GitHub push, VPS change, or deployment is part of preparing these files.
