import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Development-only showcase of the design system. It is not part of either app's build.
export default defineConfig({ root: import.meta.dirname, plugins: [react(), tailwindcss()], server: { port: 5180 } });
