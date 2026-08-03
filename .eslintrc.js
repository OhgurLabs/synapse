module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint'
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/eslint-recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  rules: {
    // no-console disabled for test suites
    'no-console': ['off']
  },
  overrides: [
    // BVT pipeline runs only heavy integration tests with @stress-cascading-failure tag
    {
      files: ['**/*-test.js','**/*.spec.ts'],
      excludedRules: ['no-restricted-syntax']
    }
  ]
}
// END .eslintrc.js