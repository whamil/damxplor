import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { handleNasApi } from "./server/nas.js";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "nas-api",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (
            !request.url?.startsWith("/api/nas")
            && !request.url?.startsWith("/api/mux")
            && !request.url?.startsWith("/api/google-drive")
          ) return next();
          handleNasApi(request, response);
        });
      },
    },
  ],
});
