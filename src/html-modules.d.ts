// jq79 components (.html files) imported as modules through jq79/vite.
declare module "*.html" {
  import type { Component79 } from "jq79";
  const component: Component79;
  export default component;
}
