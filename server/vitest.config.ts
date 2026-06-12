import { defineConfig } from 'vitest/config';

export default defineConfig({
    esbuild: {
        target: 'es2022',
        // Nest decorators; metadata emission is not needed in tests because
        // classes are constructed manually, never resolved through the DI container.
        tsconfigRaw: {
            compilerOptions: {
                experimentalDecorators: true,
            },
        },
    },
    test: {
        environment: 'node',
        include: ['test/**/*.spec.ts'],
        setupFiles: ['test/setup.ts'],
    },
});
