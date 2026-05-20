import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3200',
        changeOrigin: true,
        secure: false,
      },
      '/realdac-songs': {
        target: 'http://localhost:3200',
        changeOrigin: true,
        secure: false,
      },
      '/realdac': {
        target: 'http://localhost:3200',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
});
