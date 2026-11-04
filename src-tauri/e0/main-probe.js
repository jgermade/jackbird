// E0: runs in the main window before the app (Tauri's initialisation script). It keeps the
// page's errors and, four seconds after the load, reports whether jq79 drew the app and what
// the webview offers. See src/lib.rs.
(() => {
  if (window.top !== window) return;
  const errors = [];
  const keep = (what) => errors.push(String(what).slice(0, 300));
  window.addEventListener("error", (event) => keep(event.message || event));
  window.addEventListener("unhandledrejection", (event) => keep((event.reason && event.reason.message) || event.reason));
  const consoleError = console.error.bind(console);
  console.error = (...args) => {
    keep(args.map(String).join(" "));
    consoleError(...args);
  };
  window.addEventListener("load", () => {
    setTimeout(() => {
      const report = {
        window: "main",
        url: location.href,
        faceplate: Boolean(document.querySelector(".faceplate")),
        display: Boolean(document.querySelector(".bezel")),
        openLibraryKey: Boolean(document.querySelector(".open-folder")),
        fileSystemAccess: typeof window.showDirectoryPicker === "function",
        originPrivateFileSystem: Boolean(navigator.storage && navigator.storage.getDirectory),
        errors,
        userAgent: navigator.userAgent
      };
      window.__TAURI_INTERNALS__.invoke("e0_report", { report: JSON.stringify(report) });
    }, 4000);
  });
})();
