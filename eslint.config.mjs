import eslint from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Global ignores
  {
    ignores: ["out/", "dist/", "**/*.d.ts", "node_modules/", ".vscode-test/"],
  },

  // Base JS rules
  eslint.configs.recommended,

  // TypeScript recommended
  ...tseslint.configs.recommended,

  // SonarJS — the same rule engine SonarQube Cloud/SonarCloud uses for JS/TS
  sonarjs.configs.recommended,

  // Project-specific settings
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // Quality-gate policy: correctness and security findings fail the build.
      // Known maintainability debt is reported as warnings until it is paid down,
      // so the gate can be introduced without a single unreviewable mega-change.
      "sonarjs/cognitive-complexity": "warn",
      "sonarjs/no-nested-conditional": "warn",
      "sonarjs/no-nested-template-literals": "warn",
      "sonarjs/no-identical-functions": "warn",
      "sonarjs/regex-complexity": "warn",
      "sonarjs/super-linear-regex": "warn",
      "sonarjs/no-default-utility-imports": "warn",
      "sonarjs/function-return-type": "warn",
    },
  },

  // Lit's render() legitimately returns either `nothing` or a TemplateResult.
  {
    files: ["src/NugetPackageManager.VSCode.Webview/components/**/*.ts"],
    rules: {
      "sonarjs/function-return-type": "off",
    },
  },

  // Test files: relaxed rules
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      // Fixtures intentionally use plain HTTP, loopback-style addresses and
      // throwaway credentials to exercise the resolvers.
      "sonarjs/no-clear-text-protocols": "off",
      "sonarjs/no-hardcoded-ip": "off",
      "sonarjs/no-hardcoded-passwords": "off",
      "sonarjs/no-alphabetical-sort": "off",
      "sonarjs/assertions-in-tests": "error",
    },
  },

  // Prettier must always be last
  eslintConfigPrettier,
);
