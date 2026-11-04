//! E0.1, natively (the Tauri path): bench <file> — medians of 9 after one discarded.
use std::time::Instant;

use e0_spike::{read, write_merged, Fields};

fn median(mut xs: Vec<f64>) -> f64 {
    xs.remove(0);
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
}

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let t = Instant::now();
    let src = std::fs::read(&path).unwrap();
    let load = t.elapsed().as_secs_f64() * 1e3;
    let mut reads = Vec::new();
    let mut fields = Fields::default();
    let mut cover = None;
    for _ in 0..10 {
        let t = Instant::now();
        let (f, c) = read(&src).unwrap();
        reads.push(t.elapsed().as_secs_f64() * 1e3);
        fields = f;
        cover = c;
    }
    let edit = Fields { title: "After".into(), ..fields };
    let mut title = Vec::new();
    let mut with_cover = Vec::new();
    for _ in 0..10 {
        let t = Instant::now();
        write_merged(src.clone(), &edit, None).unwrap();
        title.push(t.elapsed().as_secs_f64() * 1e3);
        let t = Instant::now();
        write_merged(src.clone(), &edit, cover.as_ref()).unwrap();
        with_cover.push(t.elapsed().as_secs_f64() * 1e3);
    }
    println!("file {} B, read from disk {load:.1} ms; read {:.2} ms; write merged (title) {:.1} ms; write merged (title+cover) {:.1} ms (each write includes copying the source)",
        src.len(), median(reads), median(title), median(with_cover));
}
