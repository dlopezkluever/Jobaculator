# ops

Host config and the three commands that run the VPS (§17 of #31, resolution of #25). Run them from a checkout, Windows included; they need OpenSSH and, for deploy, an authenticated `gh`.

```
ops/host/            files laid onto the box at the same path (etc/…, opt/jobaculator/bin/…)
ops/host/provision.sh  runs on the box as root; idempotent
ops/provision.ts     pnpm ops:provision   upload ops/host, run provision.sh through sudo
ops/deploy.ts        pnpm ops:deploy      CI green + sha256 via gh, then sudo bin/release
ops/run.ts           pnpm ops:run         sudo bin/run <ops CLI command>
```

Point them at the box with `JOBACULATOR_HOST` (or `--host`), such as `daniel@<ipv4>` or an `~/.ssh/config` alias.

## First time

```sh
pnpm ops:provision                     # sudo asks for daniel's password
```

It installs Ubuntu's `postgresql-18`, Caddy, Node 24 and Playwright Chromium with its system deps; creates the `jobaculator-web/-worker/-migrator/-backup` OS users, the `web`/`worker`/`migrator` database roles (peer auth, no passwords) and the `jobaculator` database; installs the units, Caddyfile, Postgres, polkit, sudoers, journald and unattended-upgrades config; and generates the master key and auth secret if they are missing. **Copy new secrets into the password manager** with the `sudo cat` lines it prints. Rerun it after any change under `ops/host`.

## Deploy, create the User, sign in, roll back

```sh
pnpm ops:deploy <sha>                  # a default-branch commit with a build-<sha> release
pnpm ops:run user:create --email you@example.com --name "Your Name"
ssh -N -L 8080:127.0.0.1:80 <host>     # no-hostname mode, then open http://localhost:8080
pnpm ops:deploy --rollback             # back to the previous release (or --rollback <sha>)
pnpm ops:deploy --status
```

`bin/release activate` downloads the tarball, checks the sha256 it was given, unpacks it to `/opt/jobaculator/releases/<sha>`, waits while a Takeover is live (`--force` skips that), creates the restore point `deploy-<sha>`, runs migrations as `migrator`, stops web and worker, switches `current`, starts them, checks `/health` and the worker's start, proves the worker's egress block (`bin/release egress-check`), and keeps 5 releases. Rollback is only the switch and restart: migrations are expand-only, and a bad migration is recovered by PITR to the restore point (ADR 0005).

Logs: `journalctl -u jobaculator-web -u jobaculator-worker`.
