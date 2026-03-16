import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(opts);
}
