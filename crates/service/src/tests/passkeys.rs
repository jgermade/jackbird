//! Passkeys through the router, with a software authenticator of the tests' own (P-256, "none"
//! attestation, discoverable): added and listed, signing in without an email, and the refusals:
//! a ceremony answered twice, an old assertion, another origin, another RP ID, a sign count that
//! goes back, a passkey never added, a disabled person, sign-in off.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use sha2::{Digest, Sha256};

use super::people::{cookie_of, family, instance};
use super::*;

/// CBOR, as much as an attestation object needs.
fn head(major: u8, value: u64) -> Vec<u8> {
    let major = major << 5;
    match value {
        0..=23 => vec![major | value as u8],
        24..=0xff => vec![major | 24, value as u8],
        0x100..=0xffff => {
            let mut out = vec![major | 25];
            out.extend((value as u16).to_be_bytes());
            out
        }
        _ => {
            let mut out = vec![major | 26];
            out.extend((value as u32).to_be_bytes());
            out
        }
    }
}

fn int(value: i64) -> Vec<u8> {
    if value >= 0 {
        head(0, value as u64)
    } else {
        head(1, (-1 - value) as u64)
    }
}

fn bytes(value: &[u8]) -> Vec<u8> {
    let mut out = head(2, value.len() as u64);
    out.extend(value);
    out
}

fn text(value: &str) -> Vec<u8> {
    let mut out = head(3, value.len() as u64);
    out.extend(value.as_bytes());
    out
}

fn map(pairs: Vec<(Vec<u8>, Vec<u8>)>) -> Vec<u8> {
    let mut out = head(5, pairs.len() as u64);
    for (key, value) in pairs {
        out.extend(key);
        out.extend(value);
    }
    out
}

/// A passkey on a device of the tests' own.
struct Authenticator {
    key: SigningKey,
    id: Vec<u8>,
    handle: Vec<u8>,
    counter: u32,
}

impl Authenticator {
    fn new() -> Authenticator {
        Authenticator {
            key: SigningKey::from_slice(&crate::people::random::<32>()).unwrap(),
            id: crate::people::random::<16>().to_vec(),
            handle: Vec::new(),
            counter: 0,
        }
    }

    fn client_data(kind: &str, challenge: &Value, origin: &str) -> Vec<u8> {
        json!({ "type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false })
            .to_string()
            .into_bytes()
    }

    fn auth_data(&mut self, rp_id: &str, attested: bool) -> Vec<u8> {
        self.counter += 1;
        let mut data = Sha256::digest(rp_id.as_bytes()).to_vec();
        // User present and verified; attested credential data when it is made.
        data.push(0x01 | 0x04 | if attested { 0x40 } else { 0 });
        data.extend(self.counter.to_be_bytes());
        if attested {
            data.extend([0; 16]);
            data.extend((self.id.len() as u16).to_be_bytes());
            data.extend(&self.id);
            let point = self.key.verifying_key().to_sec1_point(false);
            let point = point.as_bytes();
            data.extend(map(vec![
                (int(1), int(2)),
                (int(3), int(-7)),
                (int(-1), int(1)),
                (int(-2), bytes(&point[1..33])),
                (int(-3), bytes(&point[33..65])),
            ]));
        }
        data
    }

    /// `navigator.credentials.create`, as the page sends its answer.
    fn create(&mut self, options: &Value, origin: &str) -> Value {
        let public_key = &options["publicKey"];
        assert_eq!(public_key["authenticatorSelection"]["residentKey"], "required");
        self.handle = B64.decode(public_key["user"]["id"].as_str().unwrap()).unwrap();
        let rp_id = public_key["rp"]["id"].as_str().unwrap().to_owned();
        let client = Self::client_data("webauthn.create", &public_key["challenge"], origin);
        let auth_data = self.auth_data(&rp_id, true);
        let attestation = map(vec![
            (text("fmt"), text("none")),
            (text("attStmt"), map(vec![])),
            (text("authData"), bytes(&auth_data)),
        ]);
        json!({
            "id": B64.encode(&self.id),
            "rawId": B64.encode(&self.id),
            "type": "public-key",
            "response": { "attestationObject": B64.encode(attestation), "clientDataJSON": B64.encode(client) },
            "extensions": {},
        })
    }

    /// `navigator.credentials.get`, discoverable: it says whose passkey it is.
    fn get(&mut self, options: &Value, origin: &str, rp_id: Option<&str>) -> Value {
        let public_key = &options["publicKey"];
        let rp_id = rp_id.unwrap_or_else(|| public_key["rpId"].as_str().unwrap()).to_owned();
        let client = Self::client_data("webauthn.get", &public_key["challenge"], origin);
        let auth_data = self.auth_data(&rp_id, false);
        let mut signed = auth_data.clone();
        signed.extend(Sha256::digest(&client));
        let signature: Signature = self.key.sign(&signed);
        json!({
            "id": B64.encode(&self.id),
            "rawId": B64.encode(&self.id),
            "type": "public-key",
            "response": {
                "authenticatorData": B64.encode(auth_data),
                "clientDataJSON": B64.encode(client),
                "signature": B64.encode(signature.to_der().as_bytes()),
                "userHandle": B64.encode(&self.handle),
            },
            "extensions": {},
        })
    }
}

const SITE: &str = "http://localhost:4646";

async fn add_passkey(app: &Router, cookie: &str, device: &mut Authenticator) -> (StatusCode, Value) {
    let (status, start) = call(Method::POST, "/api/me/passkeys/options")
        .header("cookie", cookie)
        .value(app)
        .await;
    assert_eq!(status, StatusCode::OK, "{start}");
    let credential = device.create(&start["options"], SITE);
    call(Method::POST, "/api/me/passkeys")
        .header("cookie", cookie)
        .json(json!({ "ceremony": start["ceremony"], "name": "Laptop", "credential": credential }))
        .value(app)
        .await
}

async fn options(app: &Router) -> Value {
    let (status, start) = call(Method::POST, "/api/auth/passkey/options").value(app).await;
    assert_eq!(status, StatusCode::OK, "{start}");
    assert!(start["options"]["mediation"].is_null());
    start
}

async fn answer(app: &Router, ceremony: &Value, credential: Value) -> (StatusCode, HeaderMap, Value) {
    let (status, headers, body) = call(Method::POST, "/api/auth/passkey")
        .json(json!({ "ceremony": ceremony, "credential": credential }))
        .on(app)
        .await;
    (status, headers, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_passkey_is_added_and_signs_in_without_an_email() {
    let (_, app, _, [owner, ..]) = family().await;
    let mut device = Authenticator::new();
    let (status, added) = add_passkey(&app, &owner, &mut device).await;
    assert_eq!(status, StatusCode::OK, "{added}");
    assert_eq!(added["name"], "Laptop");
    let (_, me) = call(Method::GET, "/api/me").header("cookie", &owner).value(&app).await;
    assert_eq!(me["passkeys"].as_array().unwrap().len(), 1);
    assert!(me["passkeys"][0].get("credential").is_none());
    // The same device again: refused (`webauthn-rs` checks the excluded credentials).
    let (status, _) = add_passkey(&app, &owner, &mut device).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let start = options(&app).await;
    let credential = device.get(&start["options"], SITE, None);
    let (status, headers, body) = answer(&app, &start["ceremony"], credential.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["me"]["role"], "owner");
    let cookie = cookie_of(&headers);
    assert_eq!(
        call(Method::GET, "/api/settings")
            .header("cookie", &cookie)
            .on(&app)
            .await
            .0,
        StatusCode::OK
    );
    // The same ceremony answered again: refused.
    let (status, _, body) = answer(&app, &start["ceremony"], credential.clone()).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("expired"))
    );
    // An old assertion for a new challenge: refused.
    let start = options(&app).await;
    let (status, _, _) = answer(&app, &start["ceremony"], credential).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Another origin, another RP ID: refused.
    let start = options(&app).await;
    let credential = device.get(&start["options"], "http://evil.example", None);
    assert_eq!(
        answer(&app, &start["ceremony"], credential).await.0,
        StatusCode::UNAUTHORIZED
    );
    let start = options(&app).await;
    let credential = device.get(&start["options"], SITE, Some("evil.example"));
    assert_eq!(
        answer(&app, &start["ceremony"], credential).await.0,
        StatusCode::UNAUTHORIZED
    );
    // A sign count that goes back (a cloned passkey): refused.
    device.counter = 0;
    let start = options(&app).await;
    let credential = device.get(&start["options"], SITE, None);
    assert_eq!(
        answer(&app, &start["ceremony"], credential).await.0,
        StatusCode::UNAUTHORIZED
    );
    // A passkey never added here, for the same person: refused.
    let mut stranger = Authenticator::new();
    stranger.handle.clone_from(&device.handle);
    let start = options(&app).await;
    let credential = stranger.get(&start["options"], SITE, None);
    let (status, _, body) = answer(&app, &start["ceremony"], credential).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("passkey"))
    );
    // Renamed, then removed: it no longer signs in.
    let id = added["id"].as_i64().unwrap();
    call(Method::POST, "/api/me/passkeys/rename")
        .header("cookie", &owner)
        .json(json!({ "id": id, "name": "Phone" }))
        .on(&app)
        .await;
    let (_, me) = call(Method::GET, "/api/me").header("cookie", &owner).value(&app).await;
    assert_eq!(me["passkeys"][0]["name"], "Phone");
    call(Method::POST, "/api/me/passkeys/remove")
        .header("cookie", &owner)
        .json(json!({ "id": id }))
        .on(&app)
        .await;
    let start = options(&app).await;
    let credential = device.get(&start["options"], SITE, None);
    assert_eq!(
        answer(&app, &start["ceremony"], credential).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_disabled_person_cannot_sign_in_with_a_passkey_and_passkeys_wait_for_sign_in() {
    let (service, app, _, [owner, _, editor, _]) = family().await;
    let mut device = Authenticator::new();
    assert_eq!(add_passkey(&app, &editor, &mut device).await.0, StatusCode::OK);
    // An owner gives the editor another address: until it is confirmed, no passkey signs in.
    let id = service.store.person_by_email("editor@x.es").unwrap().id;
    call(Method::POST, "/api/people/update")
        .header("cookie", &owner)
        .json(json!({ "id": id, "email": "other@x.es" }))
        .on(&app)
        .await;
    let start = options(&app).await;
    let credential = device.get(&start["options"], SITE, None);
    assert_eq!(
        answer(&app, &start["ceremony"], credential).await.0,
        StatusCode::UNAUTHORIZED
    );

    let (_, open, _) = instance();
    assert_eq!(
        call(Method::POST, "/api/auth/passkey/options").on(&open).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(Method::POST, "/api/me/passkeys/options").on(&open).await.0,
        StatusCode::CONFLICT
    );
}
