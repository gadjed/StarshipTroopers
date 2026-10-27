import { defineConfig } from 'vite';

// COOP/COEP вмикають crossOriginIsolated → SharedArrayBuffer стає доступним.
// Зараз симуляція працює в головному потоці, але BugStore уже вміє виділяти
// свої масиви в SharedArrayBuffer — це підготовка до перенесення у Web Worker.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: { target: 'es2022' },
});
