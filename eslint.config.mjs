import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".claude/**", "src/generated/**", "node_modules/**", ".data/**", ".impeccable/**", "next-env.d.ts"]),
  {
    rules: {
      // Prisma's `any` JSON and GitHub payloads are typed at the boundary, not everywhere.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
]);
