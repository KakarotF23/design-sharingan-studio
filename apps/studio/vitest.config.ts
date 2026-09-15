import { defineConfig } from "vitest/config";
export default defineConfig({ oxc: { jsx: { runtime: "automatic" } }, test: { include: ["features/**/*.test.ts", "features/**/*.test.tsx"] } });
