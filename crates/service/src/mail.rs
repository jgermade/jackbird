//! Email (S3): the codes to sign in and to turn sign-in on, and invitations, sent through the
//! SMTP server set up from the interface or the console, in the person's language.
//!
//! Each email goes as text and as HTML with the app's look (the owner, 2026-11-19): a header like
//! the faceplate with the app's icon, the code in an LCD panel, an invitation's key to the
//! instance. Styled inline, as mail clients drop stylesheets; light colours only. The icon travels
//! inside the email (`cid:logo`). See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-19).

use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Smtp;

/// The app's icon, shown at the email's top.
const LOGO: &[u8] = include_bytes!("../../../src-tauri/icons/128x128.png");

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

/// An email: its subject, its text, and the same as HTML.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Email {
    /// The subject.
    pub subject: String,
    /// The text, for clients that show no HTML.
    pub text: String,
    /// The HTML, with the app's look.
    pub html: String,
}

/// The languages the interface speaks; any other is English.
fn spanish(lang: &str) -> bool {
    lang.starts_with("es")
}

/// What an email says, in parts: the text and the HTML are made of them.
struct Parts {
    subject: String,
    /// What it is about, before the code or the key.
    lead: String,
    /// The code, if it carries one.
    code: String,
    /// An invitation's key to the instance.
    key: Option<String>,
    /// What follows: how long the code lasts, what to do.
    foot: String,
}

fn parts(kind: Kind, lang: &str, code: &str, site: &str, by: &str) -> Parts {
    let minutes = crate::auth::CODE_SECONDS / 60;
    let code = code.to_owned();
    match (kind, spanish(lang)) {
        (Kind::SignIn, false) => Parts {
            subject: format!("{code} is your jackbird code"),
            lead: format!("Enter this code to sign in to jackbird at {site}:"),
            foot: format!("It is valid for {minutes} minutes. If you did not ask for it, you can ignore this email."),
            code,
            key: None,
        },
        (Kind::SignIn, true) => Parts {
            subject: format!("{code} es tu código de jackbird"),
            lead: format!("Introduce este código para entrar en jackbird en {site}:"),
            foot: format!("Vale durante {minutes} minutos. Si no lo has pedido, puedes ignorar este correo."),
            code,
            key: None,
        },
        (Kind::Setup, false) => Parts {
            subject: format!("{code} is your jackbird setup code"),
            lead: format!("Enter this code to confirm this address and turn sign-in on in jackbird at {site}:"),
            foot: format!(
                "It is valid for {minutes} minutes. If you are not setting up jackbird, you can ignore this email."
            ),
            code,
            key: None,
        },
        (Kind::Setup, true) => Parts {
            subject: format!("{code} es tu código para configurar jackbird"),
            lead: format!(
                "Introduce este código para confirmar esta dirección y activar el inicio de sesión en jackbird en {site}:"
            ),
            foot: format!(
                "Vale durante {minutes} minutos. Si no estás configurando jackbird, puedes ignorar este correo."
            ),
            code,
            key: None,
        },
        (Kind::Invitation, false) => Parts {
            subject: "You are invited to jackbird".to_owned(),
            lead: format!("{by} added this address to jackbird, the music library at {site}."),
            foot: "Open it and sign in with this address: a code will be sent here.".to_owned(),
            code,
            key: Some("Open jackbird".to_owned()),
        },
        (Kind::Invitation, true) => Parts {
            subject: "Te han invitado a jackbird".to_owned(),
            lead: format!("{by} ha añadido esta dirección a jackbird, la biblioteca de música en {site}."),
            foot: "Ábrela y entra con esta dirección: te llegará un código aquí.".to_owned(),
            code,
            key: Some("Abrir jackbird".to_owned()),
        },
    }
}

/// Text for HTML: `&`, `<`, `>` and quotes escaped.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The email, in the person's language: as text, and as HTML with the app's look. `code` is empty
/// for an invitation; `site` is where the instance is reached.
pub fn compose(kind: Kind, lang: &str, code: &str, site: &str, by: &str) -> Email {
    let parts = parts(kind, lang, code, site, by);
    let text = if parts.code.is_empty() {
        format!("{}\n\n{}", parts.lead, parts.foot)
    } else {
        format!("{}\n\n    {}\n\n{}", parts.lead, parts.code, parts.foot)
    };
    let html = html(&parts, if spanish(lang) { "es" } else { "en" }, site);
    Email {
        subject: parts.subject,
        text,
        html,
    }
}

/// A note with no code nor key (the SMTP's test), with the same look.
pub fn note(subject: &str, text: &str) -> Email {
    let parts = Parts {
        subject: subject.to_owned(),
        lead: text.to_owned(),
        code: String::new(),
        key: None,
        foot: String::new(),
    };
    Email {
        subject: parts.subject.clone(),
        text: text.to_owned(),
        html: html(&parts, "en", ""),
    }
}

// The Deck theme's light tone (theme/default/tokens.css): mail clients know no variables.
const PAGE: &str = "#e7e9e8";
const SURFACE: &str = "#fbfbfa";
const BORDER: &str = "#c2c7c6";
const CHASSIS_HI: &str = "#eef0ef";
const CHASSIS: &str = "#d4d7d6";
const CHASSIS_LO: &str = "#b4b9b8";
const INK: &str = "#1b1d1d";
const MUTED: &str = "#535a5a";
const ACCENT: &str = "#f05a1a";
const LCD: &str = "#bfc9ac";
const LCD_INK: &str = "#1d2916";
const SANS: &str = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO: &str = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";

/// The HTML: a table laid out for mail clients, styled inline.
fn html(parts: &Parts, lang: &str, site: &str) -> String {
    let code = if parts.code.is_empty() {
        String::new()
    } else {
        format!(
            "<tr><td style=\"padding:4px 28px 18px;\"><div style=\"background:{LCD};border:1px solid #8d977c;border-radius:6px;box-shadow:inset 0 1px 3px rgba(0,0,0,.18);padding:18px 12px;text-align:center;font-family:{MONO};font-size:34px;line-height:1;font-weight:700;letter-spacing:.32em;color:{LCD_INK};\">{}</div></td></tr>",
            escape(&parts.code)
        )
    };
    let key = match (&parts.key, site.starts_with("http")) {
        (Some(label), true) => format!(
            "<tr><td style=\"padding:4px 28px 18px;\"><a href=\"{}\" style=\"display:inline-block;background:{ACCENT};color:#ffffff;text-decoration:none;font-family:{SANS};font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:12px 22px;border-radius:6px;border:1px solid #c94a13;\">{}</a></td></tr>",
            escape(site),
            escape(label)
        ),
        _ => String::new(),
    };
    format!(
        "<!doctype html>\
<html lang=\"{lang}\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<meta name=\"color-scheme\" content=\"light only\"><meta name=\"supported-color-schemes\" content=\"light\"><title>{subject}</title></head>\
<body style=\"margin:0;padding:0;background:{PAGE};\">\
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:{PAGE};\"><tr><td align=\"center\" style=\"padding:28px 12px;\">\
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:520px;background:{SURFACE};border:1px solid {BORDER};border-radius:12px;font-family:{SANS};color:{INK};\">\
<tr><td style=\"background:{CHASSIS};background-image:linear-gradient({CHASSIS_HI},{CHASSIS});border-bottom:1px solid {CHASSIS_LO};border-radius:12px 12px 0 0;padding:14px 20px;\">\
<img src=\"cid:logo\" width=\"40\" height=\"40\" alt=\"\" style=\"display:inline-block;vertical-align:middle;border:0;border-radius:9px;\">\
<span style=\"display:inline-block;vertical-align:middle;margin-left:12px;font-family:{SANS};font-size:16px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#3e4444;\">jackbird</span>\
</td></tr>\
<tr><td style=\"padding:24px 28px 14px;font-size:15px;line-height:1.55;\">{lead}</td></tr>\
{code}{key}\
<tr><td style=\"padding:4px 28px 26px;font-size:13px;line-height:1.55;color:{MUTED};\">{foot}</td></tr>\
</table></td></tr></table></body></html>",
        subject = escape(&parts.subject),
        lead = escape(&parts.lead),
        foot = escape(&parts.foot),
    )
}

/// The sender, named "jackbird" unless the address set up names someone already.
fn sender(from: &str) -> Result<Mailbox, String> {
    let named = if from.contains('<') {
        from.to_owned()
    } else {
        format!("jackbird <{from}>")
    };
    named.parse().map_err(|error| format!("the sender {from:?}: {error}"))
}

/// The message: the text and the HTML as alternatives, with the icon the HTML shows beside them.
fn message(from: &str, to: &str, email: &Email) -> Result<Message, String> {
    let logo =
        Attachment::new_inline("logo".to_owned()).body(LOGO.to_vec(), ContentType::parse("image/png").expect("a type"));
    Message::builder()
        .from(sender(from)?)
        .to(to.parse().map_err(|error| format!("the address {to:?}: {error}"))?)
        .subject(&email.subject)
        .multipart(
            MultiPart::related()
                .multipart(MultiPart::alternative_plain_html(
                    email.text.clone(),
                    email.html.clone(),
                ))
                .singlepart(logo),
        )
        .map_err(|error| error.to_string())
}

/// Sends an email through `smtp`.
pub async fn send(smtp: &Smtp, to: &str, email: &Email) -> Result<(), String> {
    let from = if smtp.from.is_empty() {
        &smtp.username
    } else {
        &smtp.from
    };
    let message = message(from, to, email)?;
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
        email: &'a Email,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
}

/// Email by SMTP.
pub struct SmtpMailer;

impl Mailer for SmtpMailer {
    fn send<'a>(
        &'a self,
        smtp: &'a Smtp,
        to: &'a str,
        email: &'a Email,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(send(smtp, to, email))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_goes_as_text_and_in_the_lcd() {
        let email = compose(Kind::SignIn, "en", "123456", "https://music.example.org", "");
        assert_eq!(email.subject, "123456 is your jackbird code");
        assert!(email.text.contains("\n\n    123456\n\n"));
        assert!(email.html.contains(">123456</div>"));
        assert!(email.html.contains("src=\"cid:logo\""));
        assert!(!email.html.contains("Open jackbird"));
        let spanish = compose(Kind::Setup, "es-ES", "654321", "https://music.example.org", "");
        assert!(spanish.subject.starts_with("654321 es tu código"));
        assert!(spanish.html.contains("lang=\"es\""));
    }

    #[test]
    fn an_invitation_has_a_key_to_the_instance_and_its_names_escaped() {
        let email = compose(
            Kind::Invitation,
            "en",
            "",
            "https://music.example.org",
            "Ana <the DJ> & co",
        );
        assert!(email.text.starts_with("Ana <the DJ> & co added this address"));
        assert!(email.html.contains("Ana &lt;the DJ&gt; &amp; co added"));
        assert!(email.html.contains("href=\"https://music.example.org\""));
        assert!(email.html.contains(">Open jackbird</a>"));
        assert!(!email.html.contains("letter-spacing:.32em"));
        // No key where the instance has no address to open.
        assert!(!compose(Kind::Invitation, "es", "", "", "Ana").html.contains("<a "));
    }

    #[test]
    fn the_sender_is_named_jackbird_unless_it_has_a_name() {
        assert_eq!(
            sender("music@example.org").unwrap().to_string(),
            "jackbird <music@example.org>"
        );
        assert_eq!(
            sender("Home <music@example.org>").unwrap().to_string(),
            "Home <music@example.org>"
        );
        assert!(sender("not an address").is_err());
    }

    #[test]
    fn the_message_carries_text_html_and_the_icon() {
        let email = compose(Kind::SignIn, "es", "123456", "https://music.example.org", "");
        let raw = String::from_utf8(
            message("music@example.org", "ana@example.org", &email)
                .unwrap()
                .formatted(),
        )
        .unwrap();
        for part in [
            "From: jackbird <music@example.org>",
            "multipart/related",
            "multipart/alternative",
            "text/plain",
            "text/html",
            "Content-ID: <logo>",
            "image/png",
        ] {
            assert!(raw.contains(part), "{part}");
        }
        assert!(
            raw.find("text/plain") < raw.find("text/html"),
            "the text first, the HTML preferred"
        );
    }

    /// Run by hand (`cargo test -p jackbird-service -- --ignored previews`): the three emails as
    /// HTML files to look at, in `.tmp/emails/` (the logo from the app's icon beside them).
    #[test]
    #[ignore = "writes files to look at"]
    fn previews() {
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.tmp/emails");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("logo.png"), LOGO).unwrap();
        for (name, email) in [
            (
                "signin-en",
                compose(Kind::SignIn, "en", "482913", "https://music.example.org", ""),
            ),
            (
                "setup-es",
                compose(Kind::Setup, "es", "107366", "https://music.example.org", ""),
            ),
            (
                "invitation-es",
                compose(Kind::Invitation, "es", "", "https://music.example.org", "Papi"),
            ),
        ] {
            std::fs::write(
                folder.join(format!("{name}.html")),
                email.html.replace("cid:logo", "logo.png"),
            )
            .unwrap();
        }
    }
}
