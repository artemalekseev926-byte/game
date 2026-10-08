// Сборка клиентского кода в web/game.js
import * as esbuild from 'esbuild';

const options = {
  entryPoints: ['src/client/main.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  outfile: 'web/game.js',
  sourcemap: process.argv.includes('--watch'),
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
