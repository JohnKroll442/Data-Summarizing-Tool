import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs so the built CSS/JS load correctly whether the app is
  // served from the domain root or a subpath. Absolute ('/') paths 404 under a
  // subpath, which renders the page completely unstyled.
  base: './',
  plugins: [react()],
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
})
