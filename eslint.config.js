import tseslint from "typescript-eslint";

const asyncForEachSelectors = [
  "CallExpression[callee.type='MemberExpression'][callee.property.name='forEach'] > ArrowFunctionExpression[async=true]",
  "CallExpression[callee.type='MemberExpression'][callee.property.name='forEach'] > FunctionExpression[async=true]",
];

export default [
  {
    ignores: ["dist/**", "node_modules/**", "reports/**", "desktop/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-unreachable": "error",
      "no-restricted-syntax": [
        "error",
        ...asyncForEachSelectors.map((selector) => ({
          selector,
          message: "Do not use an async callback with forEach because the returned promises are not awaited.",
        })),
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              name: "test",
              package: "node:test",
            },
          ],
          ignoreIIFE: true,
          ignoreVoid: true,
        },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksConditionals: true,
          checksSpreads: true,
          checksVoidReturn: false,
        },
      ],
    },
  },
];
