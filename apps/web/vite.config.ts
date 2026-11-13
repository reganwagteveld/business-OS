import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Only VITE_* variables reach the bundle (Vite's default envPrefix); server secrets never do.
export default defineConfig(({ command, mode }) => {
  // Fail the build, not the app at startup, when the API URL is missing (validated fully at runtime).
  if (command === 'build' && !loadEnv(mode, import.meta.dirname, 'VITE_').VITE_API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is required to build this app (see .env.example)');
  }
  return {
    plugins: [react(), tailwindcss()],
  };
});
