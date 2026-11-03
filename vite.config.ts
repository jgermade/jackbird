import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"]
  },
  server: {
    port: 8666
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // The default theme's demo, served at /theme/default/.
        theme: fileURLToPath(new URL("./theme/default/index.html", import.meta.url))
      }
    }
  }
});
