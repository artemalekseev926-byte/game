import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/client/main.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  outfile: 'web/game.js',
  sourcemap: watch,
  minifyWhitespace: !watch,
  legalComments: 'none',
  lineLimit: 160,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
