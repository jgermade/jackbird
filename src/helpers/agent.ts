// A session's browser, said briefly ("Chrome on Linux") from its user agent,
// for "Account" (S3). Unknown parts are left out; an empty agent says nothing.

const BROWSERS: [RegExp, string][] = [
  [/\bEdg\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bFirefox\//, "Firefox"],
  [/\b(?:Headless)?Chrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*Safari\//, "Safari"]
];

const SYSTEMS: [RegExp, string][] = [
  [/\bAndroid\b/, "Android"],
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"]
];

/** "Chrome on Linux", "Safari", "Windows", or the agent itself when nothing is known of it. */
export function describeAgent(agent: string, on = "on"): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  if (browser && system) return `${browser} ${on} ${system}`;
  return browser ?? system ?? agent.slice(0, 40);
}
