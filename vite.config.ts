import { fileURLToPath } from "node:url";
import { jq79 } from "jq79/vite";
import { defineConfig, type HtmlTagDescriptor, type Plugin, type Rollup } from "vite";

/**
 * Preloads every jq79 component script a page loads. Under safeEval, the jq79
 * plugin emits each component's precompiled functions as an asset
 * (`*.html.jq79-<hash>.js`), and each component's module awaits its script,
 * loaded as a classic `<script src>`, before the next module runs: one round
 * trip per component, in a row, before anything renders. A `<link
 * rel="preload" as="script">` for each (no `crossorigin`, as the classic
 * script has none) lets the browser fetch them all at once at the start, and
 * each `<script src>` then takes its preloaded response. Each HTML entry gets
 * the ones named in the chunks it reaches, so the app does not preload the
 * theme demo's.
 */
function preloadComponentScripts(): Plugin {
  const SCRIPT = /["'`]([\w.-]+\.html\.jq79-[\w-]+\.js)["'`]/g;

  return {
    name: "preload-component-scripts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx): HtmlTagDescriptor[] {
        const { bundle, chunk } = ctx;
        if (!bundle || !chunk) return [];
        const found = new Set<string>();
        const seen = new Set<string>();
        const scan = (fileName: string) => {
          const item = bundle[fileName];
          if (seen.has(fileName) || !item) return;
          seen.add(fileName);
          const code = item.type === "chunk" ? item.code : String(item.source);
          const dir = fileName.slice(0, fileName.lastIndexOf("/") + 1);
          for (const [, name] of code.matchAll(SCRIPT)) {
            found.add(dir + name);
            scan(dir + name);
          }
          if (item.type === "chunk") item.imports.forEach(scan);
        };
        scan(chunk.fileName);
        // The page's depth below the root, for the relative base.
        const up = "../".repeat(ctx.path.split("/").length - 2) || "./";
        return [...found]
          .filter((fileName) => bundle[fileName])
          .map((fileName) => ({
            tag: "link",
            attrs: { rel: "preload", as: "script", href: up + fileName },
            injectTo: "head"
          }));
      }
    }
  };
}

export default defineConfig({
  // Relative URLs, so one build serves from any path: GitHub Pages serves it under /jackbird/
  // (see .github/workflows/deploy.yml). The dev server still serves from /.
  base: "./",
  // jq79 components (.html) import as modules; safeEval precompiles their
  // scripts so the page runs without 'unsafe-eval'.
  plugins: [jq79({ safeEval: true }), preloadComponentScripts()],
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
