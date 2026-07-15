import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Load .env so we can read JUPITER_API_KEY in the dev proxy
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        // DexScreener — avoids CORS in dev
        '/api/dex': {
          target: 'https://api.dexscreener.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/dex/, ''),
        },
        // PumpPortal Local trade — avoids CORS in dev; prod uses api/pump.js
        '/api/pump': {
          target: 'https://pumpportal.fun',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/pump/, '/api/trade-local'),
        },
        // Jupiter proxy — injects API key server-side so it never hits the browser
        '/api/jupiter': {
          target: 'https://api.jup.ag',
          changeOrigin: true,
          rewrite: (path) => {
            // /api/jupiter?path=swap/v2/build&... → /swap/v2/build?...
            return path.replace(/^\/api\/jupiter/, '')
          },
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              // Inject the API key header server-side
              const key = env.JUPITER_API_KEY
              if (key) proxyReq.setHeader('x-api-key', key)

              // Rewrite path: strip /api/jupiter, move ?path= to the URL path
              const url = new URL(req.url, 'http://localhost')
              const jupiterPath = url.searchParams.get('path') || ''
              const remaining = new URLSearchParams(url.searchParams)
              remaining.delete('path')
              const newPath = `/${jupiterPath}${remaining.size ? '?' + remaining.toString() : ''}`
              proxyReq.path = newPath
            })
          },
        },
      },
    },
  }
})
