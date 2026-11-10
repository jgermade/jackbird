//! Email (S3): the codes to sign in and to turn sign-in on, and invitations, sent through the
//! SMTP server set up from the interface or the console, in the person's language.

use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Smtp;

/// What an email is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A code to sign in (or to sign up, the first time).
    SignIn,
    /// A code to confirm the owner's address and turn sign-in on.
    Setup,
    /// An invitation: someone gave this address a place in the instance.
    Invitation,
}

/// The languages the interface speaks; any other is English.
fn spanish(lang: &str) -> bool {
    lang.starts_with("es")
}

/// The subject and the text of an email, in the person's language. `code` is empty for an
/// invitation; `site` is where the instance is reached.
pub fn compose(kind: Kind, lang: &str, code: &str, site: &str, by: &str) -> (String, String) {
    let minutes = crate::auth::CODE_SECONDS / 60;
    match (kind, spanish(lang)) {
        (Kind::SignIn, false) => (
            format!("{code} is your jackbird code"),
            format!(
                "Enter this code to sign in to jackbird at {site}:\n\n    {code}\n\nIt is valid for {minutes} minutes. If you did not ask for it, you can ignore this email."
            ),
        ),
        (Kind::SignIn, true) => (
            format!("{code} es tu código de jackbird"),
            format!(
                "Introduce este código para entrar en jackbird en {site}:\n\n    {code}\n\nVale durante {minutes} minutos. Si no lo has pedido, puedes ignorar este correo."
            ),
        ),
        (Kind::Setup, false) => (
            format!("{code} is your jackbird setup code"),
            format!(
                "Enter this code to confirm this address and turn sign-in on in jackbird at {site}:\n\n    {code}\n\nIt is valid for {minutes} minutes. If you are not setting up jackbird, you can ignore this email."
            ),
        ),
        (Kind::Setup, true) => (
            format!("{code} es tu código para configurar jackbird"),
            format!(
                "Introduce este código para confirmar esta dirección y activar el inicio de sesión en jackbird en {site}:\n\n    {code}\n\nVale durante {minutes} minutos. Si no estás configurando jackbird, puedes ignorar este correo."
            ),
        ),
        (Kind::Invitation, false) => (
            "You are invited to jackbird".to_owned(),
            format!(
                "{by} added this address to jackbird, the music library at {site}.\n\nOpen it and sign in with this address: a code will be sent here."
            ),
        ),
        (Kind::Invitation, true) => (
            "Te han invitado a jackbird".to_owned(),
            format!(
                "{by} ha añadido esta dirección a jackbird, la biblioteca de música en {site}.\n\nÁbrela y entra con esta dirección: te llegará un código aquí."
            ),
        ),
    }
}

/// Sends an email through `smtp`.
pub async fn send(smtp: &Smtp, to: &str, subject: &str, text: &str) -> Result<(), String> {
    let from = if smtp.from.is_empty() {
        &smtp.username
    } else {
        &smtp.from
    };
    let message = Message::builder()
        .from(from.parse().map_err(|error| format!("the sender {from:?}: {error}"))?)
        .to(to.parse().map_err(|error| format!("the address {to:?}: {error}"))?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(text.to_owned())
        .map_err(|error| error.to_string())?;
    let builder = match smtp.security.as_str() {
        "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&smtp.host),
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp.host),
        _ => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&smtp.host)),
    }
    .map_err(|error| error.to_string())?;
    let mut builder = builder.port(smtp.port).timeout(Some(Duration::from_secs(30)));
    if !smtp.username.is_empty() {
        builder = builder.credentials(Credentials::new(smtp.username.clone(), smtp.password.clone()));
    }
    builder
        .build()
        .send(message)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// How email leaves: by SMTP, or kept by the tests.
pub trait Mailer: Send + Sync {
    /// Sends one email through `smtp`.
    fn send<'a>(
        &'a self,
        smtp: &'a Smtp,
        to: &'a str,
        subject: &'a str,
        text: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
}

/// Email by SMTP.
pub struct SmtpMailer;

impl Mailer for SmtpMailer {
    fn send<'a>(
        &'a self,
        smtp: &'a Smtp,
        to: &'a str,
        subject: &'a str,
        text: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(send(smtp, to, subject, text))
    }
}
