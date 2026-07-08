import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const upstream = env.VITE_COPILOT_UPSTREAM || 'http://localhost:6655/anthropic'
  const apiKey = env.VITE_ANTHROPIC_API_KEY || ''

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/hai': {
          target: upstream,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/hai/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) {
                proxyReq.setHeader('x-api-key', apiKey)
                proxyReq.setHeader('Authorization', `Bearer ${apiKey}`)
              }
              proxyReq.setHeader('anthropic-version', '2023-06-01')
            })
          },
        },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.js'],
      coverage: {
        provider: 'v8',
        include: ['src/lib/**/*.js'],
        exclude: ['src/lib/__tests__/**'],
        reporter: ['text', 'html'],
      },
    },
  }
})
