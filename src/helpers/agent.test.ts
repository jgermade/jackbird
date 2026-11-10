import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeAgent } from "./agent.ts";

describe("describeAgent", () => {
  it("names the browser and the system", () => {
    assert.equal(
      describeAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36"),
      "Chrome on Linux"
    );
    assert.equal(describeAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"), "Firefox on Windows");
    assert.equal(
      describeAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "en"),
      "Safari en macOS"
    );
    assert.equal(
      describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
      "Safari on iOS"
    );
    assert.equal(describeAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 EdgA/1 Edg/140"), "Edge on Android");
    assert.equal(describeAgent("Mozilla/5.0 (X11; CrOS x86_64) Chrome/140.0 Safari/537.36 OPR/120"), "Opera on ChromeOS");
  });

  it("says what it knows, or the agent itself", () => {
    assert.equal(describeAgent("Mozilla/5.0 (Windows NT 10.0)"), "Windows");
    assert.equal(describeAgent("Firefox/140.0"), "Firefox");
    assert.equal(describeAgent("curl/8.0"), "curl/8.0");
    assert.equal(describeAgent(""), "");
  });
});
