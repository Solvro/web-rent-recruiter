import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), tailwindcss(), react()],
	server: {
		port: 5173,
		// Backend dev server (backend/.env PORT). Override with API_PROXY_TARGET.
		proxy: { "/trpc": { target: process.env.API_PROXY_TARGET ?? "http://localhost:8788", changeOrigin: true } },
	},
});
