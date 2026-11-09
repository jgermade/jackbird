import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { creationOptions, credentialJson, fromBase64Url, passkeyProblem, requestOptions, toBase64Url } from "./passkeys.ts";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe("base64url", () => {
  it("goes both ways, with or without padding, and with the URL's alphabet", () => {
    const data = bytes(0xfb, 0xff, 0x00, 0x10);
    assert.equal(toBase64Url(data), "-_8AEA");
    assert.deepEqual(new Uint8Array(fromBase64Url("-_8AEA")), new Uint8Array(data));
    assert.deepEqual(new Uint8Array(fromBase64Url("-_8AEA==")), new Uint8Array(data));
    assert.equal(toBase64Url(new Uint8Array([1, 2, 3, 4]).subarray(1, 3)), "AgM");
  });
});

describe("options", () => {
  it("turn the challenge, the user's id and the credentials into buffers", () => {
    const created = creationOptions({
      publicKey: {
        challenge: "AQID",
        user: { id: "BAU", name: "a@x.es" },
        rp: { id: "localhost" },
        excludeCredentials: [{ id: "Bg", type: "public-key" }]
      }
    });
    assert.deepEqual(new Uint8Array(created.challenge as ArrayBuffer), new Uint8Array([1, 2, 3]));
    assert.deepEqual(new Uint8Array((created.user as { id: ArrayBuffer }).id), new Uint8Array([4, 5]));
    assert.equal((created.user as { name: string }).name, "a@x.es");
    assert.deepEqual(new Uint8Array((created.excludeCredentials as { id: ArrayBuffer }[])[0].id), new Uint8Array([6]));
    assert.deepEqual(creationOptions({ publicKey: { challenge: "", user: { id: "" } } }).excludeCredentials, []);

    const requested = requestOptions({ publicKey: { challenge: "AQID", rpId: "localhost" } });
    assert.deepEqual(new Uint8Array(requested.challenge as ArrayBuffer), new Uint8Array([1, 2, 3]));
    assert.deepEqual(requested.allowCredentials, []);
    assert.equal(requested.rpId, "localhost");
  });
});

describe("credentialJson", () => {
  it("writes a new credential with its attestation and transports", () => {
    const json = credentialJson({
      id: "AQ",
      rawId: bytes(1),
      type: "public-key",
      response: { clientDataJSON: bytes(2), attestationObject: bytes(3), getTransports: () => ["internal"] },
      getClientExtensionResults: () => ({ credProps: { rk: true } })
    });
    assert.deepEqual(json, {
      id: "AQ",
      rawId: "AQ",
      type: "public-key",
      response: { clientDataJSON: "Ag", attestationObject: "Aw", transports: ["internal"] },
      extensions: { credProps: { rk: true } }
    });
  });

  it("writes an assertion with its signature and user handle", () => {
    const json = credentialJson({
      id: "AQ",
      rawId: bytes(1),
      type: "public-key",
      response: { clientDataJSON: bytes(2), authenticatorData: bytes(4), signature: bytes(5), userHandle: bytes(6) }
    });
    assert.deepEqual(json.response, { clientDataJSON: "Ag", authenticatorData: "BA", signature: "BQ", userHandle: "Bg" });
    assert.deepEqual(json.extensions, {});
    const bare = credentialJson({ id: "AQ", rawId: bytes(1), type: "public-key", response: { clientDataJSON: bytes(2), attestationObject: bytes(3), userHandle: null } });
    assert.deepEqual(bare.response, { clientDataJSON: "Ag", attestationObject: "Aw" });
    const none = credentialJson({ id: "AQ", rawId: bytes(1), type: "public-key", response: { clientDataJSON: bytes(2) } });
    assert.deepEqual(none.response, { clientDataJSON: "Ag" });
  });
});

describe("passkeyProblem", () => {
  it("names what went wrong, and nothing when the person cancelled", () => {
    assert.equal(passkeyProblem(null), "");
    assert.equal(passkeyProblem({ name: "AbortError" }), "");
    assert.equal(passkeyProblem({ name: "NotAllowedError" }), "account.passkeyClosed");
    assert.equal(passkeyProblem({ name: "InvalidStateError" }), "account.passkeyHere");
    assert.equal(passkeyProblem({ name: "SecurityError" }), "account.passkeySecure");
    assert.equal(passkeyProblem(new Error("x")), "account.passkeyFailed");
  });
});
