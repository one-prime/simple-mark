// Bundles the extension host code (Node, CommonJS) into dist/extension.cjs. The webview is
// built by Vite (vite.config.ts), which splits the lazily loaded math renderer into chunks.
import { build } from 'esbuild';

const { metafile } = await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.cjs',
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
});

// THIRD_PARTY_NOTICES.txt lists what the webview bundles; the host must bundle nothing else.
const bundled = Object.keys(metafile.inputs).filter((path) => path.includes('node_modules/'));
if (bundled.length) throw new Error(`The extension host bundles third-party code without notices: ${bundled.join(', ')}`);
