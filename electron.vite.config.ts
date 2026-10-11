import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// index.html ships the strict production CSP. In dev, Vite injects <style> tags,
// an inline React refresh script and an HMR websocket, so only the dev server
// gets this relaxed policy (apply: 'serve'). Built output is never touched.
const devCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  main: {
    build: {
      rolldownOptions: { input: resolve('src/main/index.ts') },
    },
  },
  preload: {
    build: {
      rolldownOptions: { input: { ui: resolve('src/preload/ui.ts') } },
    },
  },
  renderer: {
    root: resolve('src/ui'),
    build: {
      minify: true,
      rolldownOptions: { input: resolve('src/ui/index.html') },
    },
    plugins: [
      react(),
      {
        name: 'dev-csp',
        apply: 'serve',
        transformIndexHtml: (html) =>
          html.replace(
            /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/,
            `$1${devCsp}$2`,
          ),
      },
    ],
  },
});
