import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) } },
  build: { outDir: "dist/web", emptyOutDir: false },
  server: {
    host: "127.0.0.1", port: 7441,
    proxy: { "/api": {
      target: "http://127.0.0.1:7443", changeOrigin: true,
      configure(proxy, options) {
        proxy.on("proxyReq", (forwarded, request) => {
          const origin = request.headers.origin;
          if (!origin || origin !== `http://${request.headers.host}`) return;
          let url: URL;
          try { url = new URL(origin); } catch { return; }
          if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && Number(url.port) === request.socket.localPort && typeof options.target === "string") forwarded.setHeader("Origin", new URL(options.target).origin);
        });
      },
    } },
  },
});
