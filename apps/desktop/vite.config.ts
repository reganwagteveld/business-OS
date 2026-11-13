import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Tauri loads the dev server on a fixed port and the built files from dist/ (src-tauri/tauri.conf.json).
export default defineConfig(({ command, mode }) => {
  // Fail the build, not the app at startup, when the API URL is missing (validated fully at runtime).
  if (command === 'build' && !loadEnv(mode, import.meta.dirname, 'VITE_').VITE_API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is required to build this app (see .env.example)');
  }
  return {
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: { port: 1420, strictPort: true },
    // WebView2 on Windows 10+ and WKWebView on macOS 11+ both support these targets.
    build: { target: ['es2022', 'chrome105', 'safari15'] },
  };
});
