import { fileURLToPath } from "node:url";
import { jq79 } from "jq79/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // jq79 components (.html) import as modules; safeEval precompiles their
  // scripts so the page runs without 'unsafe-eval'.
  plugins: [jq79({ safeEval: true })],
  resolve: {
    extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"]
  },
  server: {
    port: 8666
  },
  build: {
    // safeEval waits with a top-level await, which Vite 5 only targets from es2022.
    target: "es2022",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // The default theme's demo, served at /theme/default/.
        theme: fileURLToPath(new URL("./theme/default/index.html", import.meta.url))
      }
    }
  }
});
