//! The machine's load and temperatures (`GET /api/machine`, owners): the route for owners alone,
//! its answer's shape, and the GPU readers on what `nvidia-smi` and Linux's `/sys/class/drm` say.

use super::people::family;
use super::*;
use crate::machine::{Gpu, amd, parse_nvidia};

#[tokio::test]
async fn the_machine_is_for_owners_and_tells_its_cpu() {
    let (_, app, _, [owner, admin, editor, listener]) = family().await;
    for cookie in [&admin, &editor, &listener] {
        let status = call(Method::GET, "/api/machine")
            .header("cookie", cookie)
            .on(&app)
            .await
            .0;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, reading) = call(Method::GET, "/api/machine")
        .header("cookie", &owner)
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{reading}");
    let percent = reading["cpu"]["percent"].as_f64().unwrap();
    assert!((0.0..=100.0).contains(&percent), "{reading}");
    assert!(
        reading["cpu"]["cores"].as_u64().is_some_and(|cores| cores > 0),
        "{reading}"
    );
    assert!(
        reading["gpus"].is_array() && reading["temperatures"].is_array(),
        "{reading}"
    );
    // A second reading at once: measured from the first, still a percentage.
    let again = call(Method::GET, "/api/machine")
        .header("cookie", &owner)
        .value(&app)
        .await
        .1;
    assert!(
        (0.0..=100.0).contains(&again["cpu"]["percent"].as_f64().unwrap()),
        "{again}"
    );
}

#[test]
fn nvidia_smi_is_read() {
    let gpu = |name: &str, percent: Option<f32>, celsius: Option<f32>| Gpu {
        name: name.into(),
        percent,
        celsius,
    };
    assert_eq!(
        parse_nvidia("NVIDIA GeForce RTX 4070, 37, 61\nTesla T4, [N/A], 44\n"),
        vec![
            gpu("NVIDIA GeForce RTX 4070", Some(37.0), Some(61.0)),
            gpu("Tesla T4", None, Some(44.0))
        ]
    );
    // A name with a comma; a sensor with no reading; lines that say nothing.
    assert_eq!(
        parse_nvidia("Quadro, Mobile, 5, 0\n\nNo devices were found\n"),
        vec![gpu("Quadro, Mobile", Some(5.0), None)]
    );
}

#[test]
fn amd_gpus_are_read_from_drm() {
    let drm = scratch();
    let card = drm.join("card1/device");
    std::fs::create_dir_all(card.join("hwmon/hwmon4")).unwrap();
    std::fs::write(card.join("gpu_busy_percent"), "42\n").unwrap();
    std::fs::write(card.join("hwmon/hwmon4/temp1_input"), "55000\n").unwrap();
    std::fs::write(card.join("product_name"), "Radeon RX 7600\n").unwrap();
    // A connector, and an Intel card that tells no load: neither is a GPU here.
    std::fs::create_dir_all(drm.join("card1-DP-1")).unwrap();
    std::fs::create_dir_all(drm.join("card0/device")).unwrap();
    assert_eq!(
        amd(&drm),
        vec![Gpu {
            name: "Radeon RX 7600".into(),
            percent: Some(42.0),
            celsius: Some(55.0)
        }]
    );
    assert!(amd(&drm.join("missing")).is_empty());
}
