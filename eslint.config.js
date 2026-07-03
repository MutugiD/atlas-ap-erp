import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.bun-cache/**",
      "**/.next/**",
      "**/dist/**",
      "**/cdk.out/**",
      "**/coverage/**",
      "**/*.log",
      // Next.js-generated ambient types (regenerated on build).
      "**/next-env.d.ts",
      // k6 load scripts run under the k6 runtime, not Node — different globals.
      "tests/load/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Surface, don't block: these are style/quality signals, not correctness gates.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Tests and scripts lean on runtime globals and looser typing.
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
