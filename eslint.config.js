import js from "@eslint/js";
import zukhruf from "@zukhruf/eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".nx/**", "preview*.json"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...zukhruf.configs["github-actions"],
);
