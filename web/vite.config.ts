import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.API_ORIGIN ?? "http://localhost:3001";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": api, "/artifacts": api } },
});
