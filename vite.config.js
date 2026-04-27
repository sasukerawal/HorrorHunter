import { defineConfig } from 'vite'

const backendTarget = process.env.BIO_HORROR_BACKEND || 'http://localhost:3001'

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: backendTarget,
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
})
