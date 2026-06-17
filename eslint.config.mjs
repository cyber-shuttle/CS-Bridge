import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
    { ignores: ['out/**', 'dist/**', 'node_modules/**', '**/*.d.ts'] },
    {
        files: ['**/*.ts', '**/*.tsx'],
        extends: [
            js.configs.recommended,
            tseslint.configs.recommended,
            stylistic.configs.customize({
                indent: 4,
                quotes: 'single',
                semi: true,
                jsx: true,
                arrowParens: false,
                braceStyle: 'stroustrup',
            }),
        ],
        rules: {
            curly: 'warn',
            eqeqeq: 'warn',
            'no-throw-literal': 'warn',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            // The codebase deliberately uses compact one-liners (guard clauses, case+break) and dense JSX.
            '@stylistic/max-statements-per-line': 'off',
            '@stylistic/jsx-one-expression-per-line': 'off',
            '@stylistic/multiline-ternary': 'off',
        },
    },
);
