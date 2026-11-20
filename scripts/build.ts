import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

// Builds the release tarball (§17): bundled entry points, committed migrations and
// production node_modules. Usage: pnpm build [out.tar.gz]  (default: release.tar.gz)
const out = process.argv[2] ?? "release.tar.gz";
const stage = "build/release";

rmSync("build", { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

await build({
	entryPoints: ["src/server.ts", "src/worker.ts", "src/migrate.ts"],
	outdir: join(stage, "dist"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	packages: "external",
	sourcemap: true,
	logLevel: "warning",
});

for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".nvmrc", "drizzle"]) {
	cpSync(file, join(stage, file), { recursive: true });
}
const sha = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(join(stage, "BUILD"), `${sha}\n`);

execFileSync("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], { cwd: stage, stdio: "inherit" });
// The pinned Node 24 runtime ships in the release: units run bin/node dist/<role>.js. `pnpm build`
// runs under that runtime (package.json devEngines), so this is the lockfile's Node.
mkdirSync(join(stage, "bin"));
cpSync(process.execPath, join(stage, "bin", "node"));
execFileSync("tar", ["-czf", out, "-C", stage, "."], { stdio: "inherit" });
console.log(`built ${out} for ${sha}`);
