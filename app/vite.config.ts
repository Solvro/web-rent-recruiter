import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { candidateHead } from "./plugins/candidate-head.ts";

const BACKEND = process.env.API_PROXY_TARGET ?? "http://localhost:8788";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		tailwindcss(),
		react(),
		candidateHead(BACKEND),
	],
	server: {
		port: 5173,
		// The demo shows candidate links on a real phone through a Cloudflare quick tunnel.
		allowedHosts: [".trycloudflare.com"],
		// Backend dev server (backend/.env PORT). Override with API_PROXY_TARGET.
		proxy: { "/trpc": { target: BACKEND, changeOrigin: true } },
	},
	// `pnpm --filter app build && pnpm --filter app preview`: the stable build used for the live demo (no HMR).
	preview: {
		port: 4173,
		strictPort: true,
		allowedHosts: [".trycloudflare.com"],
		proxy: { "/trpc": { target: BACKEND, changeOrigin: true } },
	},
});
