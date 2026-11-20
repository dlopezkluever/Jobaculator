# Packages

Every package in `src/packages/<name>/` is a **deep module**: a lot of behaviour behind a small interface. `pnpm lint:boundaries` (dependency-cruiser, part of `pnpm check`) enforces the rules below.

```
src/packages/
  storage/
    index.ts        ← entry point (public). Import this from outside.
    lib/            ← implementation, hidden. Drizzle schema lives in lib/schema.ts.
    tests/          ← tests and fixtures, hidden.
```

**Entry points are root files.** Code outside a package imports only its root files, never anything in a subfolder. A package may expose several small entry points (`db` has `index.ts`, `ownership.ts` and `testing.ts`). Don't write barrel files that re-export a whole subtree.

**Inside a package, files import each other freely.**

**Tests go through entry points**, their own package's and others', plus their own `tests/` fixtures. Tests named `*.db.test.ts` run against real Postgres 18 (`.agents/setup` in an orb, a service in CI), each in its own database from `createTestDatabase()`. Every other test is pure and needs no database.

**No dependency cycles.**

**Layering (§3 of the architecture, #31).** Only `pipeline` coordinates across domain modules: no package imports `pipeline` or `src/api`. `web` code (`src/server.ts`, `src/api`, `src/web`) never reaches `browser`. Only test code imports `db/testing.ts`.

**Ownership (ADR 0006).** Every new table has `user_id uuid NOT NULL`, or goes on `GLOBAL_TABLES` in `db/ownership.ts`. A schema test fails otherwise. Owner-scoped reads take a branded `UserId` first; check them with `assertTwoUserIsolation`.

**Migrations.** Change `lib/schema.ts`, run `pnpm db:generate`, review and commit the SQL in `drizzle/`. Migrations only expand; `pnpm lint:migrations` flags destructive SQL.
