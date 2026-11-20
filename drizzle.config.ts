import { defineConfig } from "drizzle-kit";

// Each module's Drizzle schema lives in its own lib/schema.ts (#11).
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/packages/*/lib/schema.ts",
	out: "./drizzle",
});
