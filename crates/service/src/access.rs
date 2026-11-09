//! Who is asking (S3): the person behind a request, from its session (a cookie for the service's
//! own page, `Authorization: Bearer` for the desktop app), the console's key, a media token, or,
//! on an open instance with one person, that person; and the role each route asks for.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::people::{Person, Role, SESSION_SECONDS};
use crate::{ApiError, Service};

/// What the guards learnt of the request: the client's address (behind a trusted proxy, the one
/// it forwarded) and whether it came over HTTPS.
#[derive(Clone, Debug)]
pub struct Client {
    /// The client's IP address, for the limits on codes.
    pub ip: String,
    /// Whether the page is served over HTTPS (by the proxy in front).
    pub secure: bool,
}

/// The session cookie's name: `__Host-` over HTTPS, so no other page of the domain can set it.
pub fn cookie_name(secure: bool) -> &'static str {
    if secure { "__Host-jackbird" } else { "jackbird" }
}

/// The `Set-Cookie` that keeps a session in the browser.
pub fn session_cookie(token: &str, secure: bool) -> String {
    format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}{}",
        cookie_name(secure),
        if secure { "; Secure" } else { "" }
    )
}

/// The `Set-Cookie` that forgets it.
pub fn cleared_cookie(secure: bool) -> String {
    format!(
        "{}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
        cookie_name(secure),
        if secure { "; Secure" } else { "" }
    )
}

/// The session token a request carries: the bearer's, else the cookie's.
pub fn session_token(headers: &HeaderMap) -> Option<String> {
    let authorization = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok());
    if let Some(token) = authorization.and_then(|value| value.strip_prefix("Bearer ")) {
        return Some(token.trim().to_owned());
    }
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == "jackbird" || *name == "__Host-jackbird")
        .map(|(_, token)| token.to_owned())
}

/// Whether the request carries the console's key.
pub fn from_console(service: &Service, headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Console "))
        .is_some_and(|key| {
            let (key, own) = (key.trim().as_bytes(), service.console_key.as_bytes());
            key.len() == own.len() && key.iter().zip(own).fold(0, |diff, (a, b)| diff | (a ^ b)) == 0
        })
}

/// Whether a person may use the instance now: with sign-in on, once their email is confirmed.
pub fn enabled(service: &Service, person: &Person) -> bool {
    !service.settings().signin || (person.confirmed && person.email.is_some())
}

/// The owner the console acts as: the first one.
pub fn console_owner(service: &Service) -> Option<Person> {
    service
        .store
        .people()
        .ok()?
        .into_iter()
        .find(|person| person.role == Role::Owner)
}

/// A media token's value: whose it is.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct MediaGrant {
    /// The person.
    pub person: i64,
}

/// How long a media token is valid: an `<audio>` element sends no header, so the desktop app's
/// media URLs carry one (12 hours).
pub const MEDIA_SECONDS: i64 = 12 * 3600;

/// The person behind a request, if any.
pub fn caller(service: &Service, headers: &HeaderMap, query: Option<&str>) -> Option<Person> {
    if from_console(service, headers) {
        return console_owner(service);
    }
    if let Some(token) = session_token(headers) {
        return service
            .store
            .session(&token)
            .map(|(_, person)| person)
            .filter(|person| enabled(service, person));
    }
    if let Some(grant) = query
        .into_iter()
        .flat_map(|query| query.split('&'))
        .find_map(|pair| pair.strip_prefix("t="))
        .and_then(|token| service.signer.verify::<MediaGrant>("media", token))
    {
        return service
            .store
            .person(grant.person)
            .filter(|person| enabled(service, person));
    }
    if !service.settings().signin {
        let people = service.store.people().ok()?;
        if people.len() == 1 {
            return people.into_iter().next();
        }
    }
    None
}

/// The middleware of a route that asks for a role: no one is asked to sign in (or, open with
/// several people, to pick a profile); too small a role is refused. The person is handed to the
/// route.
pub async fn require(
    State((service, role)): State<(Arc<Service>, Role)>,
    mut request: Request,
    next: Next,
) -> Response {
    let query = request
        .uri()
        .path()
        .ends_with("/media")
        .then(|| request.uri().query())
        .flatten();
    match caller(&service, request.headers(), query) {
        None if service.settings().signin => {
            ApiError::new(StatusCode::UNAUTHORIZED, "signin", "sign in first").into_response()
        }
        None => ApiError::new(StatusCode::UNAUTHORIZED, "profile", "choose who is listening first").into_response(),
        Some(person) if person.role < role => ApiError::new(
            StatusCode::FORBIDDEN,
            "role",
            format!("this needs the role {} or more", role.as_str()),
        )
        .into_response(),
        Some(person) => {
            request.extensions_mut().insert(person);
            next.run(request).await
        }
    }
}
