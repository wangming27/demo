import { toolingConfig } from '@repo/eslint-config';

export default [
  {
    ignores: ['apps/**', '**/node_modules/**', '**/dist/**', '**/.turbo/**'],
  },
  ...toolingConfig,
];
