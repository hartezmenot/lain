import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.API_PORT || 8787}`;

export default defineConfig({
  server: {
    port: Number(process.env.PORT || 5173),
    strictPort: true,
    proxy: { '/api': api },
  },
});
