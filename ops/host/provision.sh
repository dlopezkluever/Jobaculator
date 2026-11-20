#!/usr/bin/env bash
# Lays ops/host onto the hardened Ubuntu 26.04 box (§17). Idempotent: rerun after any change
# under ops/host. Run by `pnpm ops:provision`, which uploads ops/host and runs this as root
# through sudo: `sudo bash provision.sh <playwright-version>`. SUDO_USER names the admin who
# gets the two passwordless sudo entries. Never runs release tarball code as root.
set -euo pipefail
umask 022

[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
src="$(cd "$(dirname "$0")" && pwd)"
admin="${ADMIN_USER:-${SUDO_USER:-}}"
[[ $admin =~ ^[a-z_][a-z0-9_-]*$ ]] && id "$admin" >/dev/null 2>&1 || { echo "ADMIN_USER/SUDO_USER must name an existing user" >&2; exit 1; }
PLAYWRIGHT_VERSION="${1:-}"
[[ $PLAYWRIGHT_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: provision.sh <playwright-version x.y.z>" >&2; exit 1; }

PG=18
NODE_MAJOR=24
export DEBIAN_FRONTEND=noninteractive
step() { echo "==> $*"; }
changed=()

# Installs ops/host/<path> at /<path> when its content or mode differs; records what changed.
put() {
	local path="$1" mode="$2" dest="/$1"
	if [[ -f $dest ]] && cmp -s "$src/$path" "$dest" && [[ $(stat -c %a "$dest") == "$mode" ]]; then return; fi
	install -D -o root -g root -m "$mode" "$src/$path" "$dest"
	changed+=("$dest")
	echo "    installed $dest"
}
was_changed() { local p; for p in "${changed[@]}"; do [[ $p == $1* ]] && return 0; done; return 1; }

step "Packages"
apt_get() { apt-get -y -q -o Dpkg::Options::=--force-confold "$@"; }
if [[ ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
	apt_get install --no-install-recommends ca-certificates curl gnupg >/dev/null
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
		>/etc/apt/sources.list.d/caddy-stable.list
fi
# Our Caddyfile goes in first, so Caddy never starts on its default config (`:80` on every interface).
put etc/caddy/Caddyfile 644
apt-get update -q >/dev/null
apt_get install --no-install-recommends "postgresql-$PG" caddy polkitd unattended-upgrades curl xz-utils openssl >/dev/null

step "OS users"
getent group jobaculator >/dev/null || groupadd --system jobaculator
for role in web worker migrator backup; do
	user="jobaculator-$role"
	id "$user" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$user"
done
# web and worker share the data directory (blobs) through the jobaculator group.
usermod -aG jobaculator jobaculator-web
usermod -aG jobaculator jobaculator-worker

step "Directories"
install -d -o root -g root -m 0755 /opt/jobaculator /opt/jobaculator/bin /opt/jobaculator/releases
install -d -o root -g root -m 0755 /var/lib/jobaculator
install -d -o root -g jobaculator -m 2770 /var/lib/jobaculator/data
install -d -o root -g root -m 0700 /etc/jobaculator /etc/jobaculator/credentials \
	/etc/jobaculator/credentials/web /etc/jobaculator/credentials/worker

step "Host config"
put opt/jobaculator/bin/release 755
put opt/jobaculator/bin/run 755
put opt/jobaculator/bin/egress-probe.mjs 644
sed "s/^ADMIN_USER /$admin /" "$src/etc/sudoers.d/jobaculator" >"$src/etc/sudoers.d/jobaculator.rendered"
visudo -cqf "$src/etc/sudoers.d/jobaculator.rendered" >/dev/null
if ! cmp -s "$src/etc/sudoers.d/jobaculator.rendered" /etc/sudoers.d/jobaculator; then
	install -o root -g root -m 0440 "$src/etc/sudoers.d/jobaculator.rendered" /etc/sudoers.d/jobaculator
	echo "    installed /etc/sudoers.d/jobaculator"
fi
put etc/postgresql/$PG/main/conf.d/jobaculator.conf 644
put etc/postgresql/$PG/main/pg_hba.conf 644
put etc/postgresql/$PG/main/pg_ident.conf 644
put etc/systemd/system/postgresql@.service.d/jobaculator.conf 644
put etc/systemd/system/jobaculator-web.service 644
put etc/systemd/system/jobaculator-worker.service 644
put etc/systemd/journald.conf.d/jobaculator.conf 644
put etc/apt/apt.conf.d/52jobaculator-unattended-upgrades 644
put etc/polkit-1/rules.d/50-jobaculator.rules 644
# polkitd reads rules as its own user.
chown root:polkitd /etc/polkit-1/rules.d/50-jobaculator.rules 2>/dev/null || true
# A freshly installed polkitd cannot claim its bus name until dbus reloads the policy that names its user.
systemctl reload dbus
systemctl reset-failed polkit 2>/dev/null || true
systemctl start polkit

systemctl daemon-reload
was_changed /etc/systemd/journald.conf.d && systemctl restart systemd-journald
was_changed /etc/postgresql || was_changed /etc/systemd/system/postgresql@ && systemctl restart "postgresql@$PG-main"
systemctl enable --now caddy >/dev/null 2>&1
was_changed /etc/caddy && systemctl reload-or-restart caddy

step "Node $NODE_MAJOR (for Playwright's installer; the app runs on the release's own bin/node)"
if [[ $(/opt/jobaculator/node/bin/node --version 2>/dev/null) != v$NODE_MAJOR.* ]]; then
	tmp="$(mktemp -d)"
	base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
	curl -fsSL --proto =https "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
	file="$(grep -oE "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
	curl -fsSL --proto =https "$base/$file" -o "$tmp/$file"
	(cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet)
	rm -rf /opt/jobaculator/node.new && mkdir /opt/jobaculator/node.new
	tar -xJf "$tmp/$file" -C /opt/jobaculator/node.new --strip-components=1 --no-same-owner
	rm -rf /opt/jobaculator/node && mv /opt/jobaculator/node.new /opt/jobaculator/node
	rm -rf "$tmp"
fi
/opt/jobaculator/node/bin/node --version

step "Playwright $PLAYWRIGHT_VERSION Chromium with system deps"
browsers=/opt/jobaculator/ms-playwright
if [[ $(cat "$browsers/.installed" 2>/dev/null) != "$PLAYWRIGHT_VERSION" ]]; then
	install -d -o root -g root -m 0755 "$browsers"
	PATH="/opt/jobaculator/node/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$browsers" npm_config_cache=/root/.npm \
		npx -y "playwright@$PLAYWRIGHT_VERSION" install --with-deps chromium
	chmod -R a+rX "$browsers"
	echo "$PLAYWRIGHT_VERSION" >"$browsers/.installed"
fi

step "Database roles and the jobaculator database (peer auth, no passwords)"
psql_root() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_root -d postgres <<'SQL'
SELECT 'CREATE ROLE ' || r || ' LOGIN' FROM unnest(ARRAY['web', 'worker', 'migrator']) AS r
	WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
SELECT 'CREATE DATABASE jobaculator OWNER migrator'
	WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'jobaculator') \gexec
SQL
psql_root -d jobaculator <<'SQL'
SET client_min_messages = warning;
-- migrator owns the database, so the public schema and every migrated table (§17).
REVOKE ALL ON DATABASE jobaculator FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE jobaculator TO web, worker;
GRANT USAGE ON SCHEMA public TO web, worker;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO web, worker;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO web, worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO web, worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO web, worker;
-- pg-boss installs and migrates itself at worker start, in a schema the worker owns; web sends jobs.
-- Its `CREATE SCHEMA IF NOT EXISTS pgboss` needs CREATE on the database even when the schema exists.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION worker;
GRANT CREATE ON DATABASE jobaculator TO worker;
GRANT USAGE ON SCHEMA pgboss TO web;
ALTER DEFAULT PRIVILEGES FOR ROLE worker IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO web;
ALTER DEFAULT PRIVILEGES FOR ROLE worker IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO web;
SQL

step "Credentials (root-only files, passed to units with LoadCredential=)"
new_secret=0
creds=/etc/jobaculator/credentials
if [[ ! -s $creds/web/master-key ]]; then
	(umask 077 && openssl rand -base64 32 >"$creds/web/master-key")
	new_secret=1
fi
if [[ ! -s $creds/web/auth-secret ]]; then
	(umask 077 && openssl rand -base64 48 >"$creds/web/auth-secret")
	new_secret=1
fi
# web and worker share the master key: both seal and open.
install -o root -g root -m 0600 "$creds/web/master-key" "$creds/worker/master-key"
chmod 0600 "$creds"/*/*

step "Units"
systemctl enable jobaculator-web jobaculator-worker >/dev/null 2>&1
if [[ -e /opt/jobaculator/current ]] && was_changed /etc/systemd/system/jobaculator-; then
	systemctl stop jobaculator-worker jobaculator-web
	systemctl start jobaculator-web jobaculator-worker
	echo "    restarted jobaculator-web and jobaculator-worker"
fi

echo
echo "Provisioned. Activate a release with: pnpm ops:deploy <sha>"
if ((new_secret)); then
	echo
	echo "NEW SECRETS were generated on the host. Copy each into your password manager now:"
	echo "  sudo cat $creds/web/master-key    (losing it makes every sealed AI key and credential unreadable)"
	echo "  sudo cat $creds/web/auth-secret"
fi
