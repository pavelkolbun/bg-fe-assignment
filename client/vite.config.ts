import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@protocol": path.resolve(
        __dirname,
        "../server/src/protocol/protocol.ts"
      ),
    },
  },
})
