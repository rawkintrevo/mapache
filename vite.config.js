import {defineConfig} from "vite";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ||
  "https://pi-agents-cloud.web.app";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
