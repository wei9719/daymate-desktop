import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Rust build output can contain hundreds of thousands of files. The unit
    // suite is source-only; browser and installer gates have separate runners.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
