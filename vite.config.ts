import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA (§3), built to dist/web and served by `web`. For `pnpm dev:web`, run `pnpm dev:server`
// with WEB_ORIGIN=http://localhost:5173 so the Origin check accepts the proxied requests.
export default defineConfig({
	root: "src/web",
	plugins: [react(), tailwindcss()],
	build: { outDir: "../../dist/web", emptyOutDir: true, modulePreload: { polyfill: false } },
	server: { proxy: { "/api": "http://localhost:3000" } },
});
