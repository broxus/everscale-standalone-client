import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import polyfillNode from 'rollup-plugin-polyfill-node';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import path from 'path';

const outDir = 'vanilla';
const libName = 'everStandalone';

export default {
  input: 'src/index.ts',
  output: [
    {
      format: 'iife',
      name: libName,
      file: path.join(outDir, 'everscale.js'),
      globals: {
        'fast-safe-stringify': 'safeStringify',
        'everscale-inpage-provider': 'everscaleInpageProvider',
        '@broxus/await-semaphore': 'awaitSemaphore',
      },
    },
    {
      format: 'iife',
      name: libName,
      file: path.join(outDir, 'everscale.min.js'),
      plugins: [terser()],
      globals: {
        'fast-safe-stringify': 'safeStringify',
        'everscale-inpage-provider': 'everscaleInpageProvider',
        '@broxus/await-semaphore': 'awaitSemaphore',
      },
    },
  ],
  plugins: [
    polyfillNode(),
    typescript({
      compilerOptions: {
        module: 'esnext',
      },
      outDir,
    }),
    commonjs({
      include: 'node_modules/**',
    }),
    nodeResolve({
      // pass custom options to the resolve plugin
      moduleDirectories: ['node_modules'],
    }),
  ],
  external: ['nekoton-wasm/nekoton_wasm_bg.wasm'],
};
