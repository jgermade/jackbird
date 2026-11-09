//! The routes of people and signing in (S3): the state the interface starts from, picking a
//! profile, codes by email, sessions, the people and their roles, SMTP, the instance's settings,
//! and turning sign-in on (by a code to the owner's address) and off.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::access::{
    Client, MEDIA_SECONDS, MediaGrant, caller, cleared_cookie, enabled, from_console, session_cookie, session_token,
};
use crate::auth::{CODE_SECONDS, Checked, attempt_id, six_digits};
use crate::config::Smtp;
use crate::mail::{Kind, compose};
use crate::people::{Person, Refusal, Role, normalize_email};
use crate::{Answer, ApiError, Service};

type Shared = State<Arc<Service>>;

pub(crate) fn refused(refusal: Refusal) -> ApiError {
    match refusal {
        Refusal::Taken => ApiError::new(StatusCode::CONFLICT, "taken", "that address is already someone's"),
        Refusal::LastOwner => ApiError::new(StatusCode::CONFLICT, "last-owner", "there must always be an owner"),
        Refusal::NotFound => ApiError::new(StatusCode::NOT_FOUND, "not-found", "no such person"),
        Refusal::Store(why) => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "io", why),
    }
}

fn lang_or_english(lang: &Option<String>) -> &str {
    lang.as_deref().unwrap_or("en")
}

/// A person as the interface sees them.
fn shown(service: &Service, person: &Person) -> Value {
    json!({
        "id": person.id,
        "name": person.name,
        "email": person.email,
        "confirmed": person.confirmed,
        "role": person.role,
        "enabled": enabled(service, person),
    })
}

/// Where the instance is reached, for emails.
fn site(service: &Service) -> String {
    let settings = service.settings();
    if settings.address.is_empty() {
        format!("http://localhost:{}", settings.port)
    } else {
        settings.address
    }
}

/// An answer that also signs in: the session's cookie, and its token when asked for (the
/// desktop app, which keeps it and sends it as a bearer).
pub(crate) fn signed_in(
    service: &Service,
    person: &Person,
    client: &Client,
    headers: &HeaderMap,
    token: bool,
) -> Answer<Response> {
    let agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let session = service.store.start_session(person.id, agent).map_err(refused)?;
    let body = json!({ "me": shown(service, person), "token": token.then_some(&session) });
    Ok((
        [(header::SET_COOKIE, session_cookie(&session, client.secure))],
        Json(body),
    )
        .into_response())
}

/// Sends an email through the instance's SMTP.
async fn send(service: &Service, to: &str, (subject, text): (String, String)) -> Answer<()> {
    let smtp = service
        .settings()
        .smtp
        .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "smtp", "email is not set up yet"))?;
    service.mailer.send(&smtp, to, &subject, &text).await.map_err(|why| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "smtp",
            format!("the email could not be sent: {why}"),
        )
    })
}

// ---------------------------------------------------------------------------------------------
// Open to anyone who reaches it.

async fn state(State(service): Shared, headers: HeaderMap) -> Json<Value> {
    let settings = service.settings();
    let me = caller(&service, &headers, None).filter(|_| !from_console(&service, &headers));
    // Open, the profiles to pick from; with sign-in, nobody's name to someone signed out.
    let profiles = (!settings.signin)
        .then(|| service.store.people().unwrap_or_default())
        .map(|people| {
            people
                .iter()
                .map(|person| json!({ "id": person.id, "name": person.name, "role": person.role }))
                .collect::<Vec<_>>()
        });
    Json(json!({
        "signin": settings.signin,
        "me": me.as_ref().map(|person| shown(&service, person)),
        "profiles": profiles,
        "smtp": settings.smtp.is_some(),
        "address": site(&service),
    }))
}

#[derive(Deserialize)]
struct Pick {
    id: i64,
    #[serde(default)]
    token: bool,
}

async fn pick_profile(
    State(service): Shared,
    Extension(client): Extension<Client>,
    headers: HeaderMap,
    Json(body): Json<Pick>,
) -> Answer<Response> {
    if service.settings().signin {
        return Err(ApiError::new(StatusCode::CONFLICT, "signin", "sign in instead"));
    }
    let person = service
        .store
        .person(body.id)
        .ok_or_else(|| refused(Refusal::NotFound))?;
    signed_in(&service, &person, &client, &headers, body.token)
}

#[derive(Deserialize)]
struct AskCode {
    email: String,
    lang: Option<String>,
}

/// What an attempt to sign in carries between asking for the code and typing it.
#[derive(Serialize, Deserialize)]
struct Attempt {
    id: String,
    person: i64,
    email: String,
}

fn limited(service: &Service, client: &Client, email: &str) -> Answer<()> {
    if !service.codes.by_ip.allow(&client.ip) || !service.codes.by_email.allow(email) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "limit",
            "too many codes asked for: wait a few minutes",
        ));
    }
    Ok(())
}

async fn ask_code(
    State(service): Shared,
    Extension(client): Extension<Client>,
    Json(body): Json<AskCode>,
) -> Answer<Json<Value>> {
    if !service.settings().signin {
        return Err(ApiError::new(StatusCode::CONFLICT, "open", "sign-in is off"));
    }
    let email = normalize_email(&body.email);
    if !email.contains('@') {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "email",
            "not an email address",
        ));
    }
    limited(&service, &client, &email)?;
    let attempt = Attempt {
        id: attempt_id(),
        person: 0,
        email: email.clone(),
    };
    // Unknown addresses get the same answer, and no email: nobody learns who has an account.
    let person = service.store.person_by_email(&email);
    let attempt = Attempt {
        person: person.as_ref().map_or(0, |person| person.id),
        ..attempt
    };
    if person.is_some() {
        let code = six_digits();
        send(
            &service,
            &email,
            compose(Kind::SignIn, lang_or_english(&body.lang), &code, &site(&service), ""),
        )
        .await?;
        service.codes.add(&attempt.id, &code);
    }
    Ok(Json(
        json!({ "attempt": service.signer.sign("signin", &attempt, CODE_SECONDS) }),
    ))
}

#[derive(Deserialize)]
struct TypedCode {
    attempt: String,
    code: String,
    #[serde(default)]
    token: bool,
}

fn checked(service: &Service, attempt: &str, code: &str) -> Answer<()> {
    match service.codes.check(attempt, code) {
        Checked::Right => Ok(()),
        Checked::Wrong => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "wrong",
            "that code is not right",
        )),
        Checked::Expired => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "expired",
            "that code has expired or was tried too often: ask for a new one",
        )),
    }
}

async fn check_code(
    State(service): Shared,
    Extension(client): Extension<Client>,
    headers: HeaderMap,
    Json(body): Json<TypedCode>,
) -> Answer<Response> {
    let attempt: Attempt = service
        .signer
        .verify("signin", &body.attempt)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "expired", "ask for a new code"))?;
    checked(&service, &attempt.id, &body.code)?;
    let person = service
        .store
        .person(attempt.person)
        .filter(|person| person.email.as_deref() == Some(attempt.email.as_str()))
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "expired", "ask for a new code"))?;
    // The first code is the sign-up: it confirms the address an owner or admin gave.
    service.store.confirm(person.id).map_err(refused)?;
    let person = service.store.person(person.id).unwrap_or(person);
    signed_in(&service, &person, &client, &headers, body.token)
}

async fn sign_out(State(service): Shared, Extension(client): Extension<Client>, headers: HeaderMap) -> Response {
    if let Some((session, _)) = session_token(&headers).and_then(|token| service.store.session(&token)) {
        service.store.end_session(session.id);
    }
    (
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, cleared_cookie(client.secure))],
    )
        .into_response()
}

/// Routes anyone who reaches the service may use.
pub fn open() -> Router<Arc<Service>> {
    Router::new()
        .route("/auth/state", get(state))
        .route("/auth/profile", post(pick_profile))
        .route("/auth/code", post(ask_code))
        .route("/auth/code/check", post(check_code))
        .route("/auth/signout", post(sign_out))
}

// ---------------------------------------------------------------------------------------------
// Everyone's own: their name, their sessions.

async fn me(State(service): Shared, Extension(person): Extension<Person>) -> Answer<Json<Value>> {
    let sessions = service.store.sessions_of(person.id).map_err(refused)?;
    let passkeys = service.store.passkeys_of(person.id).map_err(refused)?;
    Ok(Json(json!({
        "me": shown(&service, &person),
        "sessions": sessions,
        "passkeys": passkeys,
    })))
}

#[derive(Deserialize)]
struct Name {
    name: String,
}

pub(crate) fn valid_name(name: &str) -> Answer<String> {
    let name: String = name.trim().chars().take(64).collect();
    if name.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "name",
            "a name is needed",
        ));
    }
    Ok(name)
}

async fn rename_me(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Name>,
) -> Answer<StatusCode> {
    service
        .store
        .rename(person.id, &valid_name(&body.name)?)
        .map_err(refused)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Id {
    id: i64,
}

async fn end_session(State(service): Shared, Extension(person): Extension<Person>, Json(body): Json<Id>) -> StatusCode {
    service.store.end_session_of(person.id, body.id);
    StatusCode::NO_CONTENT
}

async fn media_token(State(service): Shared, Extension(person): Extension<Person>) -> Json<Value> {
    let grant = MediaGrant { person: person.id };
    Json(json!({ "t": service.signer.sign("media", &grant, MEDIA_SECONDS) }))
}

/// Routes of everyone with a place in the instance (listeners and up).
pub fn own() -> Router<Arc<Service>> {
    Router::new()
        .route("/me", get(me).post(rename_me))
        .route("/me/sessions/end", post(end_session))
        .route("/media/token", get(media_token))
}

// ---------------------------------------------------------------------------------------------
// Admins and owners: the people, the log, SMTP.

/// Whether `actor` may add, change or remove someone with `role` (admins up to editor).
fn may_manage(actor: &Person, role: Role) -> bool {
    actor.role == Role::Owner || (actor.role == Role::Admin && role <= Role::Editor)
}

fn not_allowed() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "role", "only an owner may do that")
}

async fn people(State(service): Shared) -> Answer<Json<Vec<Value>>> {
    let people = service.store.people().map_err(refused)?;
    Ok(Json(people.iter().map(|person| shown(&service, person)).collect()))
}

#[derive(Deserialize)]
struct NewPerson {
    name: String,
    email: Option<String>,
    role: String,
    lang: Option<String>,
}

fn role_of(name: &str) -> Answer<Role> {
    Role::parse(name).ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "role", "no such role"))
}

/// Invites someone to an instance with sign-in on; whether the email left.
async fn invite(service: &Service, by: &Person, email: &str, lang: &str) -> bool {
    service.settings().signin
        && send(
            service,
            email,
            compose(Kind::Invitation, lang, "", &site(service), &by.name),
        )
        .await
        .is_ok()
}

async fn add_person(
    State(service): Shared,
    Extension(actor): Extension<Person>,
    Json(body): Json<NewPerson>,
) -> Answer<Json<Value>> {
    let role = role_of(&body.role)?;
    if !may_manage(&actor, role) {
        return Err(not_allowed());
    }
    let email = body
        .email
        .as_deref()
        .map(normalize_email)
        .filter(|email| !email.is_empty());
    if service.settings().signin && email.is_none() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "email",
            "with sign-in on, people are invited by email",
        ));
    }
    if email.as_deref().is_some_and(|email| !email.contains('@')) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "email",
            "not an email address",
        ));
    }
    let person = service
        .store
        .add(&valid_name(&body.name)?, email.as_deref(), role)
        .map_err(refused)?;
    let invited = match &email {
        Some(email) => invite(&service, &actor, email, lang_or_english(&body.lang)).await,
        None => false,
    };
    Ok(Json(json!({ "person": shown(&service, &person), "invited": invited })))
}

#[derive(Deserialize)]
struct Change {
    id: i64,
    name: Option<String>,
    /// An email to set; empty to take it away.
    email: Option<String>,
    role: Option<String>,
    lang: Option<String>,
}

async fn change_person(
    State(service): Shared,
    Extension(actor): Extension<Person>,
    Json(body): Json<Change>,
) -> Answer<Json<Value>> {
    let target = service
        .store
        .person(body.id)
        .ok_or_else(|| refused(Refusal::NotFound))?;
    if !may_manage(&actor, target.role) {
        return Err(not_allowed());
    }
    if let Some(name) = &body.name {
        service.store.rename(target.id, &valid_name(name)?).map_err(refused)?;
    }
    let mut invited = false;
    if let Some(email) = &body.email {
        let email = normalize_email(email);
        if !email.is_empty() && !email.contains('@') {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "email",
                "not an email address",
            ));
        }
        if service.settings().signin && email.is_empty() {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "email",
                "with sign-in on, an email is needed",
            ));
        }
        if target.email.as_deref() != Some(email.as_str()) {
            service
                .store
                .set_email(
                    target.id,
                    Some(&email).filter(|email| !email.is_empty()).map(String::as_str),
                )
                .map_err(refused)?;
            if service.settings().signin {
                // A new address is confirmed again; until then, its sessions end.
                service.store.end_sessions_of(target.id);
                invited = invite(&service, &actor, &email, lang_or_english(&body.lang)).await;
            }
        }
    }
    if let Some(role) = &body.role {
        let role = role_of(role)?;
        if !may_manage(&actor, role) {
            return Err(not_allowed());
        }
        service.store.set_role(target.id, role).map_err(refused)?;
    }
    let person = service
        .store
        .person(target.id)
        .ok_or_else(|| refused(Refusal::NotFound))?;
    Ok(Json(json!({ "person": shown(&service, &person), "invited": invited })))
}

async fn remove_person(
    State(service): Shared,
    Extension(actor): Extension<Person>,
    Json(body): Json<Id>,
) -> Answer<StatusCode> {
    let target = service
        .store
        .person(body.id)
        .ok_or_else(|| refused(Refusal::NotFound))?;
    if !may_manage(&actor, target.role) {
        return Err(not_allowed());
    }
    service.store.remove(target.id).map_err(refused)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Limit {
    limit: Option<u32>,
}

async fn log(State(service): Shared, Query(limit): Query<Limit>) -> Answer<Json<Value>> {
    let changes = service
        .store
        .changes(limit.limit.unwrap_or(200).min(1000))
        .map_err(refused)?;
    Ok(Json(json!(changes)))
}

/// SMTP as the interface sees it: everything but the password, which it can only replace.
fn smtp_shown(smtp: Option<&Smtp>) -> Value {
    smtp.map_or(Value::Null, |smtp| {
        json!({
            "host": smtp.host,
            "port": smtp.port,
            "security": smtp.security,
            "username": smtp.username,
            "from": smtp.from,
            "password": !smtp.password.is_empty(),
        })
    })
}

async fn smtp(State(service): Shared) -> Json<Value> {
    Json(smtp_shown(service.settings().smtp.as_ref()))
}

#[derive(Deserialize)]
struct SmtpChange {
    host: String,
    port: u16,
    security: String,
    #[serde(default)]
    username: String,
    /// A new password; absent keeps the one there is.
    password: Option<String>,
    #[serde(default)]
    from: String,
}

async fn set_smtp(State(service): Shared, Json(body): Json<SmtpChange>) -> Answer<Json<Value>> {
    if body.host.trim().is_empty() || !matches!(body.security.as_str(), "tls" | "starttls" | "none") {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "smtp",
            "a host, a port and a security (tls, starttls or none) are needed",
        ));
    }
    service.change_settings(|settings| {
        let password = body
            .password
            .clone()
            .or_else(|| settings.smtp.as_ref().map(|smtp| smtp.password.clone()))
            .unwrap_or_default();
        settings.smtp = Some(Smtp {
            host: body.host.trim().to_owned(),
            port: body.port,
            security: body.security.clone(),
            username: body.username.trim().to_owned(),
            password,
            from: body.from.trim().to_owned(),
        });
    });
    Ok(Json(smtp_shown(service.settings().smtp.as_ref())))
}

#[derive(Deserialize)]
struct TestEmail {
    to: String,
}

async fn test_smtp(State(service): Shared, Json(body): Json<TestEmail>) -> Answer<StatusCode> {
    send(
        &service,
        &normalize_email(&body.to),
        (
            "jackbird: a test email".to_owned(),
            format!("Email from jackbird at {} works.", site(&service)),
        ),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Routes of admins and owners.
pub fn admins() -> Router<Arc<Service>> {
    Router::new()
        .route("/people", get(people).post(add_person))
        .route("/people/update", post(change_person))
        .route("/people/remove", post(remove_person))
        .route("/log", get(log))
        .route("/smtp", get(smtp).post(set_smtp))
        .route("/smtp/test", post(test_smtp))
}

// ---------------------------------------------------------------------------------------------
// Owners: the instance's settings, and turning sign-in on and off.

async fn settings(State(service): Shared) -> Json<Value> {
    let settings = service.settings();
    Json(json!({
        "signin": settings.signin,
        "address": settings.address,
        "network": settings.network,
        "proxies": settings.proxies,
    }))
}

#[derive(Deserialize)]
struct SettingsChange {
    address: Option<String>,
    network: Option<bool>,
    proxies: Option<Vec<String>>,
}

async fn set_settings(State(service): Shared, Json(body): Json<SettingsChange>) -> Answer<Json<Value>> {
    if let Some(address) = &body.address {
        let address = address.trim().trim_end_matches('/');
        let host = address
            .strip_prefix("https://")
            .or_else(|| address.strip_prefix("http://"))
            .unwrap_or("");
        if !address.is_empty() && (host.is_empty() || host.contains('/')) {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "address",
                "the address is an origin, such as https://music.example.com",
            ));
        }
    }
    if let Some(proxies) = &body.proxies
        && proxies.iter().any(|proxy| proxy.parse::<std::net::IpAddr>().is_err())
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "proxies",
            "the proxies are IP addresses",
        ));
    }
    service.change_settings(|settings| {
        if let Some(address) = &body.address {
            settings.address = address.trim().trim_end_matches('/').to_owned();
        }
        if let Some(network) = body.network {
            settings.network = network;
        }
        if let Some(proxies) = &body.proxies {
            settings.proxies.clone_from(proxies);
        }
    });
    Ok(settings(State(service)).await)
}

#[derive(Deserialize)]
struct SetupEmail {
    email: String,
    /// The owner whose address it is (the console, with several owners); the caller otherwise.
    person: Option<i64>,
    lang: Option<String>,
}

/// What an attempt to confirm an owner's address carries.
#[derive(Serialize, Deserialize)]
struct SetupAttempt {
    id: String,
    person: i64,
    email: String,
}

async fn setup_email(
    State(service): Shared,
    Extension(actor): Extension<Person>,
    Extension(client): Extension<Client>,
    headers: HeaderMap,
    Json(body): Json<SetupEmail>,
) -> Answer<Json<Value>> {
    let owner = match body.person {
        Some(id) if from_console(&service, &headers) => service
            .store
            .person(id)
            .filter(|person| person.role == Role::Owner)
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not-found", "no such owner"))?,
        _ => actor,
    };
    let email = normalize_email(&body.email);
    if !email.contains('@') {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "email",
            "not an email address",
        ));
    }
    if service
        .store
        .person_by_email(&email)
        .is_some_and(|other| other.id != owner.id)
    {
        return Err(refused(Refusal::Taken));
    }
    limited(&service, &client, &email)?;
    let code = six_digits();
    send(
        &service,
        &email,
        compose(Kind::Setup, lang_or_english(&body.lang), &code, &site(&service), ""),
    )
    .await?;
    let attempt = SetupAttempt {
        id: attempt_id(),
        person: owner.id,
        email: email.clone(),
    };
    service.codes.add(&attempt.id, &code);
    Ok(Json(json!({
        "attempt": service.signer.sign("setup", &attempt, CODE_SECONDS),
        "owner": owner.name,
    })))
}

#[derive(Deserialize)]
struct SetupCode {
    attempt: String,
    code: String,
    lang: Option<String>,
    #[serde(default)]
    token: bool,
}

async fn setup_code(
    State(service): Shared,
    Extension(client): Extension<Client>,
    headers: HeaderMap,
    Json(body): Json<SetupCode>,
) -> Answer<Response> {
    let attempt: SetupAttempt = service
        .signer
        .verify("setup", &body.attempt)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "expired", "ask for a new code"))?;
    checked(&service, &attempt.id, &body.code)?;
    service
        .store
        .set_email(attempt.person, Some(&attempt.email))
        .and_then(|()| service.store.confirm(attempt.person))
        .map_err(refused)?;
    let owner = service
        .store
        .person(attempt.person)
        .ok_or_else(|| refused(Refusal::NotFound))?;
    if !service.settings().signin {
        // Sign-in on: no role changes, every session ends, and those with an address waiting
        // for its confirmation are invited.
        service.change_settings(|settings| settings.signin = true);
        service.store.end_all_sessions();
        for person in service.store.people().unwrap_or_default() {
            if let (Some(email), false) = (&person.email, person.confirmed) {
                invite(&service, &owner, email, lang_or_english(&body.lang)).await;
            }
        }
    }
    if from_console(&service, &headers) {
        return Ok(Json(json!({ "me": shown(&service, &owner) })).into_response());
    }
    signed_in(&service, &owner, &client, &headers, body.token)
}

#[derive(Deserialize)]
struct SignIn {
    on: bool,
}

async fn set_signin(
    State(service): Shared,
    Extension(client): Extension<Client>,
    Json(body): Json<SignIn>,
) -> Answer<Response> {
    if body.on {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "setup",
            "sign-in is turned on by confirming an owner's address (setup)",
        ));
    }
    if service.settings().signin {
        // Sign-in off: people keep their addresses and passkeys and are profiles again; every
        // session ends; the instance answers on the machine only.
        service.change_settings(|settings| settings.signin = false);
        service.store.end_all_sessions();
    }
    Ok((
        [(header::SET_COOKIE, cleared_cookie(client.secure))],
        Json(json!({ "signin": false })),
    )
        .into_response())
}

/// Routes of owners.
pub fn owners() -> Router<Arc<Service>> {
    Router::new()
        .route("/settings", get(settings).post(set_settings))
        .route("/setup/email", post(setup_email))
        .route("/setup/code", post(setup_code))
        .route("/signin", post(set_signin))
}
