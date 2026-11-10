//! Passkeys (S3-D6 as amended at 11:20): `webauthn-rs`, with intergate's choices. The RP ID is
//! the host of the instance's address and assertions are accepted from that exact origin;
//! passkeys are discoverable (a resident key required) with user verification required, so
//! signing in needs no email first; a ceremony's state travels signed, valid 5 minutes, and each
//! challenge is answered once; a credential is kept whole and updated on each use, and one whose
//! sign count goes back is refused (`webauthn-rs` refuses it as a possible clone); passkeys have
//! names. They are added once signed in, with sign-in on.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use webauthn_rs::prelude::{
    DiscoverableAuthentication, DiscoverableKey, Passkey, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Url, Uuid, Webauthn, WebauthnBuilder,
};

use crate::access::{Client, enabled};
use crate::auth::attempt_id;
use crate::people::{Person, now};
use crate::people_api::{refused, signed_in, valid_name};
use crate::{Answer, ApiError, Service};

const CEREMONY_SECONDS: i64 = 5 * 60;

/// The instance's origin: its address, or the machine's own.
fn origin(service: &Service) -> String {
    let settings = service.settings();
    if settings.address.is_empty() {
        format!("http://localhost:{}", settings.port)
    } else {
        settings.address
    }
}

/// The relying party: the instance's address and its host as the RP ID.
fn party(service: &Service) -> Answer<Webauthn> {
    let unusable = |why: String| ApiError::new(StatusCode::CONFLICT, "passkeys", why);
    let origin = origin(service);
    let url = Url::parse(&origin).map_err(|error| unusable(format!("{origin}: {error}")))?;
    let host = url.host_str().unwrap_or("localhost").to_owned();
    WebauthnBuilder::new(&host, &url)
        .and_then(|builder| builder.rp_name("jackbird").build())
        .map_err(|error| unusable(format!("passkeys on {origin}: {error}")))
}

fn failed(error: impl std::fmt::Display) -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "passkey",
        format!("the passkey could not be verified: {error}"),
    )
}

/// A ceremony's state, signed, between its options and its answer.
#[derive(Serialize, Deserialize)]
struct Ceremony<T> {
    id: String,
    state: T,
}

fn start<T: Serialize>(service: &Service, purpose: &str, state: T) -> String {
    let ceremony = Ceremony {
        id: attempt_id(),
        state,
    };
    service.signer.sign(purpose, &ceremony, CEREMONY_SECONDS)
}

fn finish<T: serde::de::DeserializeOwned>(service: &Service, purpose: &str, token: &str) -> Answer<T> {
    let ceremony: Ceremony<T> = service
        .signer
        .verify(purpose, token)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "expired", "this attempt expired: try again"))?;
    if !service.ceremonies.first(&ceremony.id, now() + CEREMONY_SECONDS) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "expired",
            "this attempt was answered already",
        ));
    }
    Ok(ceremony.state)
}

fn signin_on(service: &Service) -> Answer<()> {
    if service.settings().signin {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::CONFLICT,
            "open",
            "passkeys are for sign-in, which is off",
        ))
    }
}

fn user_id(person: &Person) -> Uuid {
    Uuid::from_slice(&person.handle).unwrap_or_else(|_| Uuid::from_bytes([0; 16]))
}

fn kept(person: &Person, service: &Service) -> Answer<Vec<(i64, Passkey)>> {
    Ok(service
        .store
        .passkeys_of(person.id)
        .map_err(refused)?
        .into_iter()
        .filter_map(|key| {
            serde_json::from_str(&key.credential)
                .ok()
                .map(|passkey| (key.id, passkey))
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Adding one, signed in.

async fn register_options(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
) -> Answer<Json<Value>> {
    signin_on(&service)?;
    let party = party(&service)?;
    let exclude = kept(&person, &service)?
        .iter()
        .map(|(_, passkey)| passkey.cred_id().clone())
        .collect();
    let email = person.email.clone().unwrap_or_default();
    let (options, state) = party
        .start_passkey_registration(user_id(&person), &email, &person.name, Some(exclude))
        .map_err(failed)?;
    // Discoverable, so signing in needs no email first (as intergate).
    let mut options = json!(options);
    options["publicKey"]["authenticatorSelection"]["residentKey"] = json!("required");
    options["publicKey"]["authenticatorSelection"]["requireResidentKey"] = json!(true);
    Ok(Json(json!({
        "options": options,
        "ceremony": start::<PasskeyRegistration>(&service, "passkey-register", state),
    })))
}

#[derive(Deserialize)]
struct Register {
    ceremony: String,
    name: Option<String>,
    credential: RegisterPublicKeyCredential,
}

async fn register(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Json(body): Json<Register>,
) -> Answer<Json<Value>> {
    signin_on(&service)?;
    let state: PasskeyRegistration = finish(&service, "passkey-register", &body.ceremony)?;
    let passkey = party(&service)?
        .finish_passkey_registration(&body.credential, &state)
        .map_err(failed)?;
    let name = match body.name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => valid_name(name)?,
        _ => format!("Passkey of {}", chrono_day()),
    };
    let credential = serde_json::to_string(&passkey).map_err(failed)?;
    let added = service
        .store
        .add_passkey(person.id, &name, passkey.cred_id().as_ref(), &credential)
        .map_err(|refusal| match refusal {
            crate::people::Refusal::Taken => {
                ApiError::new(StatusCode::CONFLICT, "taken", "this passkey is registered already")
            }
            other => refused(other),
        })?;
    Ok(Json(json!(added)))
}

/// Today, as a date (for a passkey's default name).
fn chrono_day() -> String {
    let days = now().div_euclid(86_400);
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[derive(Deserialize)]
struct Named {
    id: i64,
    name: String,
}

async fn rename(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Json(body): Json<Named>,
) -> Answer<StatusCode> {
    service
        .store
        .rename_passkey(person.id, body.id, &valid_name(&body.name)?);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Id {
    id: i64,
}

async fn remove(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Json(body): Json<Id>,
) -> StatusCode {
    service.store.remove_passkey(person.id, body.id);
    StatusCode::NO_CONTENT
}

/// Routes of everyone's own passkeys.
pub fn own() -> Router<Arc<Service>> {
    Router::new()
        .route("/me/passkeys/options", post(register_options))
        .route("/me/passkeys", post(register))
        .route("/me/passkeys/rename", post(rename))
        .route("/me/passkeys/remove", post(remove))
}

// ---------------------------------------------------------------------------------------------
// Signing in with one.

#[derive(Deserialize, Default)]
struct SignInOptions {
    /// Offered in the email field's autofill rather than in a dialog.
    #[serde(default)]
    autofill: bool,
}

async fn sign_in_options(
    State(service): State<Arc<Service>>,
    body: Option<Json<SignInOptions>>,
) -> Answer<Json<Value>> {
    signin_on(&service)?;
    let (mut options, state) = party(&service)?.start_discoverable_authentication().map_err(failed)?;
    if !body.is_some_and(|Json(body)| body.autofill) {
        options.mediation = None;
    }
    Ok(Json(json!({
        "options": options,
        "ceremony": start::<DiscoverableAuthentication>(&service, "passkey-signin", state),
    })))
}

#[derive(Deserialize)]
struct SignIn {
    ceremony: String,
    credential: PublicKeyCredential,
    #[serde(default)]
    token: bool,
}

async fn sign_in(
    State(service): State<Arc<Service>>,
    Extension(client): Extension<Client>,
    headers: HeaderMap,
    Json(body): Json<SignIn>,
) -> Answer<Response> {
    signin_on(&service)?;
    let state: DiscoverableAuthentication = finish(&service, "passkey-signin", &body.ceremony)?;
    let party = party(&service)?;
    let unknown = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "passkey",
            "this passkey is not registered here: sign in with your email and add it from your account",
        )
    };
    let (handle, credential_id) = party
        .identify_discoverable_authentication(&body.credential)
        .map_err(|_| unknown())?;
    let person = service
        .store
        .person_by_handle(handle.as_bytes())
        .filter(|person| enabled(&service, person))
        .ok_or_else(unknown)?;
    let passkeys = kept(&person, &service)?;
    let (_, mut passkey) = passkeys
        .into_iter()
        .find(|(_, passkey)| passkey.cred_id().as_ref() == credential_id)
        .ok_or_else(unknown)?;
    let result = party
        .finish_discoverable_authentication(&body.credential, state, &[DiscoverableKey::from(&passkey)])
        .map_err(failed)?;
    passkey.update_credential(&result);
    if let Ok(credential) = serde_json::to_string(&passkey) {
        service.store.passkey_used(passkey.cred_id().as_ref(), &credential);
    }
    signed_in(&service, &person, &client, &headers, body.token)
}

/// Routes of signing in with a passkey.
pub fn open() -> Router<Arc<Service>> {
    Router::new()
        .route("/auth/passkey/options", post(sign_in_options))
        .route("/auth/passkey", post(sign_in))
}
