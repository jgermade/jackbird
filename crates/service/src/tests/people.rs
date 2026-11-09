//! S3 through the router: profiles, turning sign-in on by an owner's code, codes and their
//! limits, every route against every role, what admins and owners may do to people, sessions,
//! the log, the console's key, media tokens, and the guards with sign-in on.

use std::sync::{Arc, Mutex};

use super::*;
use crate::config::{Config, Smtp};
use crate::people::{Role, Store};

/// The emails sent, kept instead of sent.
#[derive(Clone, Default)]
pub(super) struct Outbox(Arc<Mutex<Vec<(String, String, String)>>>);

impl mail::Mailer for Outbox {
    fn send<'a>(
        &'a self,
        _: &'a Smtp,
        to: &'a str,
        subject: &'a str,
        text: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        self.0.lock().unwrap().push((to.into(), subject.into(), text.into()));
        Box::pin(async { Ok(()) })
    }
}

impl Outbox {
    fn sent(&self) -> Vec<(String, String, String)> {
        self.0.lock().unwrap().clone()
    }

    /// The code of the last email to `to` (its subject starts with it).
    fn code_for(&self, to: &str) -> String {
        let sent = self.sent();
        let (_, subject, _) = sent.iter().rev().find(|(own, _, _)| own == to).expect("an email");
        subject[..6].to_owned()
    }
}

fn smtp() -> Smtp {
    Smtp {
        host: "smtp.example".into(),
        port: 587,
        security: "starttls".into(),
        username: "jackbird@example.com".into(),
        password: "secret".into(),
        from: String::new(),
    }
}

/// A service with SMTP set up and an outbox, open, with its first person (the owner).
pub(super) fn instance() -> (Arc<Service>, Router, Outbox) {
    let outbox = Outbox::default();
    let settings = Config {
        smtp: Some(smtp()),
        ..Config::default()
    };
    let service = Service::with_mailer(settings, None, Store::memory(), Box::new(outbox.clone()));
    let app = router(Arc::clone(&service));
    (service, app, outbox)
}

pub(super) fn cookie_of(headers: &HeaderMap) -> String {
    let set = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    set.split(';').next().unwrap().to_owned()
}

/// Turns sign-in on as the owner, confirming `email`; the owner's cookie.
pub(super) async fn turn_signin_on(app: &Router, outbox: &Outbox, email: &str) -> String {
    let (status, body) = call(Method::POST, "/api/setup/email")
        .json(json!({ "email": email }))
        .value(app)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, headers, _) = call(Method::POST, "/api/setup/code")
        .json(json!({ "attempt": body["attempt"], "code": outbox.code_for(email) }))
        .on(app)
        .await;
    assert_eq!(status, StatusCode::OK);
    cookie_of(&headers)
}

/// Signs in by code; the cookie.
pub(super) async fn sign_in(app: &Router, outbox: &Outbox, email: &str) -> String {
    let (status, body) = call(Method::POST, "/api/auth/code")
        .json(json!({ "email": email, "lang": "es" }))
        .value(app)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, headers, _) = call(Method::POST, "/api/auth/code/check")
        .json(json!({ "attempt": body["attempt"], "code": outbox.code_for(email) }))
        .on(app)
        .await;
    assert_eq!(status, StatusCode::OK);
    cookie_of(&headers)
}

#[tokio::test]
async fn an_instance_starts_with_its_owner_and_no_sign_in() {
    let (service, app, _) = instance();
    let (status, state) = call(Method::GET, "/api/auth/state").value(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["signin"], false);
    assert_eq!(state["me"]["role"], "owner");
    assert_eq!(state["profiles"].as_array().unwrap().len(), 1);
    // One person, open: they are everyone, with no session.
    assert_eq!(call(Method::GET, "/api/folders").on(&app).await.0, StatusCode::OK);
    assert_eq!(service.store.people().unwrap()[0].role, Role::Owner);
}

#[tokio::test]
async fn several_people_without_sign_in_pick_a_profile() {
    let (service, app, _) = instance();
    let (status, headers, body) = call(Method::POST, "/api/people")
        .json(json!({ "name": "Kids", "role": "listener" }))
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    let added: Value = serde_json::from_slice(&body).unwrap();
    // The one who added the second person keeps being themselves, by a session made now.
    let first = cookie_of(&headers);
    assert!(added["token"].is_string());
    assert_eq!(
        call(Method::GET, "/api/folders")
            .header("cookie", &first)
            .on(&app)
            .await
            .0,
        StatusCode::OK
    );
    // Two people now: who is listening must be said first.
    let (status, body) = call(Method::GET, "/api/roots").value(&app).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("profile"))
    );
    let (_, state) = call(Method::GET, "/api/auth/state").value(&app).await;
    assert_eq!(state["profiles"].as_array().unwrap().len(), 2);
    assert!(state["me"].is_null());
    let kids = added["person"]["id"].as_i64().unwrap();
    let (status, headers, _) = call(Method::POST, "/api/auth/profile")
        .json(json!({ "id": kids }))
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    let kids_cookie = cookie_of(&headers);
    assert!(kids_cookie.starts_with("jackbird="));
    // A listener reads, and may not write or browse the machine.
    assert_eq!(
        call(Method::GET, "/api/roots")
            .header("cookie", &kids_cookie)
            .on(&app)
            .await
            .0,
        StatusCode::OK
    );
    let (status, body) = call(Method::GET, "/api/folders")
        .header("cookie", &kids_cookie)
        .value(&app)
        .await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::FORBIDDEN, Some("role")));
    // The desktop app asks for the token, and sends it as a bearer.
    let owner = service.store.people().unwrap()[0].id;
    let (_, body) = call(Method::POST, "/api/auth/profile")
        .json(json!({ "id": owner, "token": true }))
        .value(&app)
        .await;
    let bearer = format!("Bearer {}", body["token"].as_str().unwrap());
    assert_eq!(
        call(Method::GET, "/api/folders")
            .header("authorization", &bearer)
            .on(&app)
            .await
            .0,
        StatusCode::OK
    );
    // Codes are for sign-in, which is off.
    assert_eq!(
        call(Method::POST, "/api/auth/code")
            .json(json!({ "email": "a@example.com" }))
            .on(&app)
            .await
            .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn turning_sign_in_on_changes_no_role_and_disables_profiles_until_their_email_is_confirmed() {
    let (service, app, outbox) = instance();
    let owner = service.store.people().unwrap()[0].id;
    let (_, headers, _) = call(Method::POST, "/api/auth/profile")
        .json(json!({ "id": owner }))
        .on(&app)
        .await;
    let before = cookie_of(&headers);
    for (name, role) in [("Ana", "admin"), ("Luis", "editor"), ("Kids", "listener")] {
        let status = call(Method::POST, "/api/people")
            .header("cookie", &before)
            .json(json!({ "name": name, "role": role }))
            .on(&app)
            .await
            .0;
        assert_eq!(status, StatusCode::OK);
    }
    // Only an owner turns it on: an admin's profile may not.
    let ana = service.store.people().unwrap()[1].id;
    let (_, headers, _) = call(Method::POST, "/api/auth/profile")
        .json(json!({ "id": ana }))
        .on(&app)
        .await;
    let (status, _) = call(Method::POST, "/api/setup/email")
        .header("cookie", &cookie_of(&headers))
        .json(json!({ "email": "ana@example.com" }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) = call(Method::POST, "/api/setup/email")
        .header("cookie", &before)
        .json(json!({ "email": "Owner@Example.com", "lang": "es" }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sent = outbox.sent();
    assert_eq!(sent[0].0, "owner@example.com");
    assert!(sent[0].1.contains("configurar jackbird"), "{}", sent[0].1);
    // A wrong code, then the right one.
    let (status, wrong) = call(Method::POST, "/api/setup/code")
        .header("cookie", &before)
        .json(json!({ "attempt": body["attempt"], "code": "000000x" }))
        .value(&app)
        .await;
    assert_eq!(
        (status, wrong["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("wrong"))
    );
    let (status, headers, _) = call(Method::POST, "/api/setup/code")
        .header("cookie", &before)
        .json(json!({ "attempt": body["attempt"], "code": outbox.code_for("owner@example.com") }))
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    let owner_cookie = cookie_of(&headers);
    assert!(service.settings().signin);
    // Every role as it was; the others disabled (no confirmed email); old sessions ended.
    let people = service.store.people().unwrap();
    let roles: Vec<Role> = people.iter().map(|person| person.role).collect();
    assert_eq!(roles, [Role::Owner, Role::Admin, Role::Editor, Role::Listener]);
    let (_, list) = call(Method::GET, "/api/people")
        .header("cookie", &owner_cookie)
        .value(&app)
        .await;
    let enabled: Vec<bool> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["enabled"].as_bool().unwrap())
        .collect();
    assert_eq!(enabled, [true, false, false, false]);
    assert_eq!(
        call(Method::GET, "/api/roots")
            .header("cookie", &before)
            .value(&app)
            .await
            .1["code"],
        "signin"
    );
    // No more picking.
    assert_eq!(
        call(Method::POST, "/api/auth/profile")
            .json(json!({ "id": ana }))
            .on(&app)
            .await
            .0,
        StatusCode::CONFLICT
    );
    // The owner gives Ana an email: she is invited, signs in with a code, and is an admin again.
    let (status, changed) = call(Method::POST, "/api/people/update")
        .header("cookie", &owner_cookie)
        .json(json!({ "id": ana, "email": "ana@example.com" }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["invited"], true);
    assert!(outbox.sent().last().unwrap().1.contains("invited"));
    let ana_cookie = sign_in(&app, &outbox, "ana@example.com").await;
    assert!(outbox.sent().last().unwrap().1.contains("es tu código"));
    let (_, me) = call(Method::GET, "/api/me")
        .header("cookie", &ana_cookie)
        .value(&app)
        .await;
    assert_eq!(
        (me["me"]["role"].as_str(), me["me"]["enabled"].as_bool()),
        (Some("admin"), Some(true))
    );
}

#[tokio::test]
async fn codes_answer_the_same_for_unknown_addresses_burn_after_five_tries_and_are_limited() {
    let (_, app, outbox) = instance();
    turn_signin_on(&app, &outbox, "owner@example.com").await;
    let sent = outbox.sent().len();
    let (status, body) = call(Method::POST, "/api/auth/code")
        .json(json!({ "email": "stranger@example.com" }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["attempt"].is_string());
    assert_eq!(outbox.sent().len(), sent, "no email to an unknown address");
    let (status, body) = call(Method::POST, "/api/auth/code/check")
        .json(json!({ "attempt": body["attempt"], "code": "123456" }))
        .value(&app)
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("expired"))
    );

    let (_, body) = call(Method::POST, "/api/auth/code")
        .json(json!({ "email": "owner@example.com" }))
        .value(&app)
        .await;
    let right = outbox.code_for("owner@example.com");
    let wrong = if right == "000000" { "111111" } else { "000000" };
    for _ in 0..4 {
        let (_, answer) = call(Method::POST, "/api/auth/code/check")
            .json(json!({ "attempt": body["attempt"], "code": wrong }))
            .value(&app)
            .await;
        assert_eq!(answer["code"], "wrong");
    }
    let (_, answer) = call(Method::POST, "/api/auth/code/check")
        .json(json!({ "attempt": body["attempt"], "code": wrong }))
        .value(&app)
        .await;
    assert_eq!(answer["code"], "expired");
    let (status, _) = call(Method::POST, "/api/auth/code/check")
        .json(json!({ "attempt": body["attempt"], "code": right }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "burnt");
    // A forged attempt: refused.
    let (status, _) = call(Method::POST, "/api/auth/code/check")
        .json(json!({ "attempt": "e30.AAAA", "code": right }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Five codes per address in 15 minutes (setup's and the one above count).
    let mut statuses = Vec::new();
    for _ in 0..4 {
        statuses.push(
            call(Method::POST, "/api/auth/code")
                .json(json!({ "email": "owner@example.com" }))
                .on(&app)
                .await
                .0,
        );
    }
    assert_eq!(
        statuses,
        [
            StatusCode::OK,
            StatusCode::OK,
            StatusCode::OK,
            StatusCode::TOO_MANY_REQUESTS
        ]
    );
}

/// The roles' cookies on an instance with sign-in on: owner, admin, editor, listener.
pub(super) async fn family() -> (Arc<Service>, Router, Outbox, [String; 4]) {
    let (service, app, outbox) = instance();
    let owner = turn_signin_on(&app, &outbox, "owner@example.com").await;
    let mut cookies = vec![owner.clone()];
    for (email, role) in [
        ("admin@x.es", "admin"),
        ("editor@x.es", "editor"),
        ("listener@x.es", "listener"),
    ] {
        let (status, body) = call(Method::POST, "/api/people")
            .header("cookie", &owner)
            .json(json!({ "name": role, "email": email, "role": role }))
            .value(&app)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["invited"], true);
        cookies.push(sign_in(&app, &outbox, email).await);
    }
    (service, app, outbox, cookies.try_into().unwrap())
}

#[tokio::test]
async fn every_route_asks_for_its_role() {
    let (_, app, _, cookies) = family().await;
    let folder = library();
    let owner = &cookies[0];
    let (status, _) = call(Method::POST, "/api/roots")
        .header("cookie", owner)
        .json(json!({ "path": folder }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    let root = enc(&folder);
    let file = "mp3-junk.mp3";
    let at = format!("root={root}&path={file}");
    // Each route, and the least role it needs (0 listener .. 3 owner); a 4 needs no one.
    let routes: Vec<(Method, String, Value, usize)> = vec![
        (Method::GET, "/api/info".into(), Value::Null, 4),
        (Method::GET, "/api/auth/state".into(), Value::Null, 4),
        (Method::GET, "/api/roots".into(), Value::Null, 0),
        (Method::GET, format!("/api/walk?root={root}"), Value::Null, 0),
        (Method::GET, format!("/api/list?root={root}"), Value::Null, 0),
        (Method::GET, format!("/api/read?{at}"), Value::Null, 0),
        (Method::GET, format!("/api/stat?{at}"), Value::Null, 0),
        (
            Method::POST,
            "/api/inspect".into(),
            json!({ "root": folder, "path": file }),
            0,
        ),
        (Method::GET, format!("/api/media?{at}"), Value::Null, 0),
        (Method::GET, "/api/me".into(), Value::Null, 0),
        (Method::GET, "/api/media/token".into(), Value::Null, 0),
        (
            Method::POST,
            format!("/api/write?root={root}&path=notes.txt"),
            json!("x"),
            1,
        ),
        (Method::POST, format!("/api/mkdir?root={root}&path=new"), Value::Null, 1),
        (
            Method::POST,
            "/api/rename".into(),
            json!({ "root": folder, "from": "new", "to": "newer" }),
            1,
        ),
        (
            Method::POST,
            format!("/api/delete?root={root}&path=newer"),
            Value::Null,
            1,
        ),
        (Method::GET, "/api/people".into(), Value::Null, 2),
        (Method::GET, "/api/log".into(), Value::Null, 2),
        (Method::GET, "/api/smtp".into(), Value::Null, 2),
        (Method::GET, "/api/settings".into(), Value::Null, 3),
        (Method::GET, "/api/folders".into(), Value::Null, 3),
    ];
    for (method, uri, body, least) in routes {
        // From the least role up it is answered, below it refused; signed out, refused.
        for (rank, cookie) in cookies.iter().rev().enumerate() {
            let mut request = call(method.clone(), uri.clone()).header("cookie", cookie);
            if !body.is_null() {
                request = request.json(body.clone());
            }
            let status = request.on(&app).await.0;
            // Allowed: whatever the operation answers, but not a refusal of who is asking.
            if least == 4 || rank >= least {
                assert!(
                    status != StatusCode::FORBIDDEN && status != StatusCode::UNAUTHORIZED,
                    "{method} {uri} as rank {rank}: {status}"
                );
            } else {
                assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri} as rank {rank}");
            }
        }
        let status = call(method.clone(), uri.clone()).on(&app).await.0;
        if least == 4 {
            assert!(status.is_success(), "{uri} signed out");
        } else {
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} signed out");
        }
    }
    // The log names who did what.
    let (_, log) = call(Method::GET, "/api/log").header("cookie", owner).value(&app).await;
    let actions: Vec<(&str, &str)> = log
        .as_array()
        .unwrap()
        .iter()
        .map(|change| (change["person"].as_str().unwrap(), change["action"].as_str().unwrap()))
        .collect();
    assert!(actions.contains(&("editor", "write")), "{actions:?}");
    assert!(actions.contains(&("Owner", "open")), "{actions:?}");
}

#[tokio::test]
async fn admins_manage_editors_and_listeners_owners_manage_everyone_and_one_owner_is_left() {
    let (service, app, _, [owner, admin, editor, _]) = family().await;
    let id = |email: &str| service.store.person_by_email(email).unwrap().id;
    // An admin may not make an admin, nor touch an owner or an admin.
    for body in [
        json!({ "name": "x", "email": "x@x.es", "role": "admin" }),
        json!({ "name": "x", "email": "x@x.es", "role": "owner" }),
    ] {
        let status = call(Method::POST, "/api/people")
            .header("cookie", &admin)
            .json(body)
            .on(&app)
            .await
            .0;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let status = call(Method::POST, "/api/people/update")
        .header("cookie", &admin)
        .json(json!({ "id": id("owner@example.com"), "role": "listener" }))
        .on(&app)
        .await
        .0;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let status = call(Method::POST, "/api/people/update")
        .header("cookie", &admin)
        .json(json!({ "id": id("editor@x.es"), "role": "admin" }))
        .on(&app)
        .await
        .0;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // An admin may demote an editor, and invite with sign-in on only by email.
    let status = call(Method::POST, "/api/people/update")
        .header("cookie", &admin)
        .json(json!({ "id": id("editor@x.es"), "role": "listener" }))
        .on(&app)
        .await
        .0;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        call(Method::GET, "/api/people")
            .header("cookie", &editor)
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let status = call(Method::POST, "/api/people")
        .header("cookie", &admin)
        .json(json!({ "name": "Nobody", "role": "listener" }))
        .on(&app)
        .await
        .0;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    // An owner promotes another owner, and demotes; the last one stays.
    let status = call(Method::POST, "/api/people/update")
        .header("cookie", &owner)
        .json(json!({ "id": id("admin@x.es"), "role": "owner" }))
        .on(&app)
        .await
        .0;
    assert_eq!(status, StatusCode::OK);
    let status = call(Method::POST, "/api/people/update")
        .header("cookie", &admin)
        .json(json!({ "id": id("owner@example.com"), "role": "admin" }))
        .on(&app)
        .await
        .0;
    assert_eq!(status, StatusCode::OK, "the new owner demotes the first");
    let (status, body) = call(Method::POST, "/api/people/update")
        .header("cookie", &admin)
        .json(json!({ "id": id("admin@x.es"), "role": "admin" }))
        .value(&app)
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("last-owner"))
    );
    let (status, _) = call(Method::POST, "/api/people/remove")
        .header("cookie", &admin)
        .json(json!({ "id": id("admin@x.es") }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // An address already someone's: refused.
    let (status, body) = call(Method::POST, "/api/people/update")
        .header("cookie", &admin)
        .json(json!({ "id": id("editor@x.es"), "email": "Owner@example.com" }))
        .value(&app)
        .await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::CONFLICT, Some("taken")));
}

#[tokio::test]
async fn sessions_are_listed_ended_and_signed_out() {
    let (_, app, outbox, [owner, ..]) = family().await;
    let other = sign_in(&app, &outbox, "owner@example.com").await;
    let (_, me) = call(Method::GET, "/api/me").header("cookie", &owner).value(&app).await;
    let sessions = me["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert!(sessions[0].get("token").is_none());
    let other_id = sessions.iter().map(|s| s["id"].as_i64().unwrap()).max().unwrap();
    call(Method::POST, "/api/me/sessions/end")
        .header("cookie", &owner)
        .json(json!({ "id": other_id }))
        .on(&app)
        .await;
    assert_eq!(
        call(Method::GET, "/api/me").header("cookie", &other).on(&app).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, headers, _) = call(Method::POST, "/api/auth/signout")
        .header("cookie", &owner)
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(cookie_of(&headers).ends_with('='));
    assert_eq!(
        call(Method::GET, "/api/me").header("cookie", &owner).on(&app).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn only_an_owner_turns_sign_in_off_and_it_answers_on_the_machine_only_again() {
    let (service, app, _, [owner, admin, ..]) = family().await;
    assert_eq!(
        call(Method::POST, "/api/signin")
            .header("cookie", &admin)
            .json(json!({ "on": false }))
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(Method::POST, "/api/signin")
            .header("cookie", &owner)
            .json(json!({ "on": true }))
            .on(&app)
            .await
            .0,
        StatusCode::CONFLICT
    );
    // With sign-in on, the home network reaches it.
    assert_eq!(
        call(Method::GET, "/api/info")
            .header("host", "192.168.1.10:4646")
            .header("origin", "http://192.168.1.10:4646")
            .from("192.168.1.20:50000")
            .on(&app)
            .await
            .0,
        StatusCode::OK
    );
    let (status, _) = call(Method::POST, "/api/signin")
        .header("cookie", &owner)
        .json(json!({ "on": false }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!service.settings().signin);
    // People keep their addresses and roles, as profiles; sessions ended.
    let people = service.store.people().unwrap();
    assert_eq!(people.len(), 4);
    assert!(people.iter().all(|person| person.email.is_some()));
    assert_eq!(
        call(Method::GET, "/api/roots")
            .header("cookie", &owner)
            .value(&app)
            .await
            .1["code"],
        "profile"
    );
    assert_eq!(
        call(Method::GET, "/api/info")
            .header("host", "192.168.1.10:4646")
            .from("192.168.1.20:50000")
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn behind_a_proxy_cookies_are_secure_and_an_open_instance_refuses_it() {
    let (_, app, outbox) = instance();
    // Open: a request a proxy forwarded is refused, even from the machine.
    assert_eq!(
        call(Method::GET, "/api/info")
            .header("x-forwarded-for", "203.0.113.5")
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    turn_signin_on(&app, &outbox, "owner@example.com").await;
    let through_proxy = |method: Method, uri: &str| {
        call(method, uri)
            .header("host", "music.example.com")
            .header("origin", "https://music.example.com")
            .header("x-forwarded-for", "203.0.113.5")
            .header("x-forwarded-proto", "https")
    };
    let (_, body) = through_proxy(Method::POST, "/api/auth/code")
        .json(json!({ "email": "owner@example.com" }))
        .value(&app)
        .await;
    let (status, headers, _) = through_proxy(Method::POST, "/api/auth/code/check")
        .json(json!({ "attempt": body["attempt"], "code": outbox.code_for("owner@example.com") }))
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    let set = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set.starts_with("__Host-jackbird=") && set.contains("; Secure") && set.contains("HttpOnly"));
    // Another site's page, through the same proxy: refused.
    assert_eq!(
        through_proxy(Method::POST, "/api/auth/code")
            .header("origin", "https://evil.example")
            .json(json!({ "email": "owner@example.com" }))
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // Forwarded headers from an untrusted peer are not believed: the page's origin is http.
    assert_eq!(
        through_proxy(Method::GET, "/api/auth/state")
            .from("198.51.100.7:4000")
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn the_console_acts_as_an_owner_and_media_tokens_reach_media() {
    let (service, app, outbox, [_, _, _, listener]) = family().await;
    let console = format!("Console {}", service.console_key());
    let (status, _) = call(Method::GET, "/api/settings")
        .header("origin", "")
        .header("authorization", &console)
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        call(Method::GET, "/api/settings")
            .header("authorization", "Console nope")
            .on(&app)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // The console confirms an owner's new address (recovery), without a session of its own.
    let owner = service.store.people().unwrap()[0].id;
    let (status, body) = call(Method::POST, "/api/setup/email")
        .header("origin", "")
        .header("authorization", &console)
        .json(json!({ "email": "new@example.com", "person": owner }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, headers, _) = call(Method::POST, "/api/setup/code")
        .header("origin", "")
        .header("authorization", &console)
        .json(json!({ "attempt": body["attempt"], "code": outbox.code_for("new@example.com") }))
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.get(header::SET_COOKIE).is_none());
    assert_eq!(
        service.store.person(owner).unwrap().email.as_deref(),
        Some("new@example.com")
    );
    // A media token is good for media alone.
    let folder = library();
    call(Method::POST, "/api/roots")
        .header("authorization", &console)
        .json(json!({ "path": folder }))
        .on(&app)
        .await;
    let (_, token) = call(Method::GET, "/api/media/token")
        .header("cookie", &listener)
        .value(&app)
        .await;
    let t = token["t"].as_str().unwrap();
    let media = format!("/api/media?root={}&path=mp3-junk.mp3&t={t}", enc(&folder));
    assert_eq!(call(Method::GET, media).on(&app).await.0, StatusCode::OK);
    assert_eq!(
        call(Method::GET, format!("/api/roots?t={t}")).on(&app).await.0,
        StatusCode::UNAUTHORIZED
    );
}
