## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `dlopezkluever/Jobaculator` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Code layout

Packages are deep modules: see [src/packages/README.md](./src/packages/README.md) before adding or importing one. `pnpm check` runs typecheck, Biome, dependency-cruiser, the migration check and Vitest; DB tests need Postgres 18 (started by `.agents/setup` / `.agents/resume` in an orb).
