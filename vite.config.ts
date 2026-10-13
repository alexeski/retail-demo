import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { SERVER_ENV_KEYS } from './server/config.ts'

/**
 * Serves Storeloom's API (server/api.ts) from the dev server, so `npm run dev`
 * is one process and the app calls /api on its own origin, as in production.
 * Server settings (THOUGHTSPOT_SECRET_KEY…) come from .env.local.
 */
function storeloomApi(): Plugin {
  return {
    name: 'storeloom-api',
    configureServer(server) {
      // Read the files directly: Vite's loadEnv lets values already in process.env
      // win, and its restarts on .env edits reuse this process, so a value set
      // earlier (even a blank one) would stick.
      const mode = server.config.mode
      const env = Object.assign(
        {},
        ...['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
          .filter((f) => existsSync(f))
          .map((f) => parseEnv(readFileSync(f, 'utf8'))),
      ) as Record<string, string>
      for (const key of SERVER_ENV_KEYS) {
        if (env[key] !== undefined) process.env[key] = env[key]
      }
      // Loaded per request through Vite, so edits to server/ apply without a restart;
      // the app is rebuilt only when the module actually reloads.
      const apps = new WeakMap<object, ReturnType<typeof import('./server/api.ts').createApi>>()
      server.middlewares.use('/api', (req, res, next) => {
        server
          .ssrLoadModule('/server/api.ts')
          .then(({ createApi }) => {
            if (!apps.has(createApi)) apps.set(createApi, createApi())
            apps.get(createApi)!(req as never, res as never, next)
          })
          .catch(next)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), storeloomApi()],
})
