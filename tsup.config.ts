import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // The package ships no runtime dependencies. Anything that appears in the
  // bundle is a mistake, so fail loudly rather than silently vendoring it.
  external: [],
});
