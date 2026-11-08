//! `jackbird-service`: the service, started by hand in S1 (S2 makes the system start it).
//!
//! ```text
//! jackbird-service [--port N] [--config PATH]
//! ```
//!
//! It listens on 127.0.0.1 (and ::1) only, on the configuration's port (4646 by default), and
//! prints its address.

use std::net::SocketAddr;

use jackbird_service::config::{self, Config};

fn usage() -> ! {
    eprintln!("usage: jackbird-service [--port N] [--config PATH]");
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let (mut port, mut path) = (None, config::default_path());
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                port = Some(
                    args.next()
                        .and_then(|value| value.parse().ok())
                        .unwrap_or_else(|| usage()),
                )
            }
            "--config" => path = args.next().map(Into::into).unwrap_or_else(|| usage()),
            _ => usage(),
        }
    }
    let config = Config::load(&path).unwrap_or_else(|error| {
        eprintln!("jackbird-service: the configuration cannot be read: {error}");
        std::process::exit(1);
    });
    let port = port.unwrap_or(config.port);
    let service = jackbird_service::Service::new(port, Some(path.clone()), &config.roots);
    let app = jackbird_service::router(service);

    let v4 = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
        .await
        .unwrap_or_else(|error| {
            eprintln!("jackbird-service: 127.0.0.1:{port} is not free ({error}); set another port with --port");
            std::process::exit(1);
        });
    // ::1 too where the machine has it, since browsers may try it first for `localhost`.
    if let Ok(v6) = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port))).await {
        let app = app.clone();
        tokio::spawn(async move { axum::serve(v6, app).await });
    }
    println!(
        "jackbird-service: http://localhost:{port}/ (configuration: {})",
        path.display()
    );
    axum::serve(v4, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap_or_else(|error| eprintln!("jackbird-service: {error}"));
}
