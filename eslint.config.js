import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "coverage/", "dist/", ".assetgrove/", "packages/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Core works without search: it never imports the search package, LanceDB or Transformers.js.
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(@clockgrove/assetgrove-search|@lancedb/|@huggingface/|onnxruntime-)|assetgrove-search",
              message: "Core never imports the search package, LanceDB or Transformers.js.",
            },
          ],
        },
      ],
    },
  },
);
