import { defineConfig } from "vitest/config";

// `unit`: pure tests, no Postgres. `db`: real Postgres 18 integration tests (`*.db.test.ts`).
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
					exclude: ["**/*.db.test.ts", "**/node_modules/**"],
				},
			},
			{
				test: {
					name: "db",
					include: ["src/**/*.db.test.ts"],
					globalSetup: ["./src/test-global-setup.ts"],
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
		],
	},
});
