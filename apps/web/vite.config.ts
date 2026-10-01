import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // dev convenience: /ws proxies to the signaling server
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
})