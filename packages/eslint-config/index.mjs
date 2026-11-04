import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ignores = {
  ignores: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.turbo/**',
    '**/coverage/**',
    '**/src/generated/**',
    '**/.test-dist/**',
  ],
};

export const toolingConfig = [
  ignores,
  {
    ...eslint.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
];

function createTypeScriptConfig(tsconfigRootDir) {
  return tseslint.config(ignores, {
    files: ['**/*.{ts,tsx}'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  });
}

export function createReactConfig(tsconfigRootDir) {
  return [
    ...toolingConfig,
    ...createTypeScriptConfig(tsconfigRootDir),
    {
      files: ['src/**/*.{ts,tsx}'],
      languageOptions: {
        globals: globals.browser,
      },
      plugins: {
        'react-hooks': reactHooks,
        'react-refresh': reactRefresh,
      },
      rules: {
        ...reactHooks.configs.recommended.rules,
        ...reactRefresh.configs.vite.rules,
      },
    },
    {
      files: ['vite.config.ts'],
      languageOptions: {
        globals: globals.node,
      },
    },
    prettier,
  ];
}

export function createNestConfig(tsconfigRootDir) {
  return [
    ...toolingConfig,
    ...createTypeScriptConfig(tsconfigRootDir),
    {
      files: ['**/*.ts'],
      languageOptions: {
        globals: globals.node,
      },
      rules: {
        // Nest's decorator metadata needs class imports at runtime.
        '@typescript-eslint/consistent-type-imports': 'off',
      },
    },
    prettier,
  ];
}
