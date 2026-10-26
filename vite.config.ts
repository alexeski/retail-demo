import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // ThoughtSpot's Spotter MCP Server sends no CORS headers, so the browser
      // reaches it through this origin (nginx.conf does the same in production).
      // A plain pass-through: the user's own bearer token rides in each request.
      '/ts-mcp': {
        target: 'https://agent.thoughtspot.app',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ts-mcp/, '/token/mcp'),
      },
    },
  },
})
