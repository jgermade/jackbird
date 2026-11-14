//! A cover from an MP3's tags, decoded to RGB pixels for the iPod's artwork:
//! JPEG with `zune-jpeg`, PNG with `png`. The format is told by the bytes'
//! signature, not the tag's MIME type, which files get wrong.

use crate::Cover;
use zune_jpeg::zune_core::bytestream::ZCursor;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;

/// The largest side decoded: covers are a few hundred to a few thousand
/// pixels, and the iPod shows them at 240; a bound on what a malformed file can
/// make jackbird allocate.
pub const MAX_SIDE: usize = 8192;

/// The cover's pixels, or `None` when the bytes are neither a JPEG nor a PNG
/// jackbird can read.
pub fn decode(bytes: &[u8]) -> Option<Cover> {
    if bytes.starts_with(&[0xff, 0xd8]) {
        jpeg(bytes)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        png(bytes)
    } else {
        None
    }
}

fn jpeg(bytes: &[u8]) -> Option<Cover> {
    let options = DecoderOptions::default()
        .jpeg_set_out_colorspace(ColorSpace::RGB)
        .set_max_width(MAX_SIDE)
        .set_max_height(MAX_SIDE);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    let components = decoder.output_colorspace()?.num_components();
    rgb_of(pixels, width, height, components)
}

fn png(bytes: &[u8]) -> Option<Cover> {
    let mut decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(bytes),
        png::Limits {
            bytes: MAX_SIDE * MAX_SIDE * 4,
        },
    );
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let frame = reader.next_frame(&mut buf).ok()?;
    buf.truncate(frame.buffer_size());
    let components = match frame.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return None,
    };
    rgb_of(buf, frame.width, frame.height, components)
}

/// Pixels of 1 to 4 components as RGB: grey spread to three, alpha dropped
/// (the iPod's background is black, and covers are opaque).
fn rgb_of(pixels: Vec<u8>, width: u32, height: u32, components: usize) -> Option<Cover> {
    let count = (width as usize).checked_mul(height as usize)?;
    if width == 0 || height == 0 || pixels.len() < count * components {
        return None;
    }
    let rgb = match components {
        3 => pixels[..count * 3].to_vec(),
        1 | 2 => pixels.chunks(components).take(count).flat_map(|p| [p[0]; 3]).collect(),
        4 => pixels.chunks(4).take(count).flat_map(|p| [p[0], p[1], p[2]]).collect(),
        _ => return None,
    };
    Some(Cover { width, height, rgb })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2×1 PNG (red, blue), written with the same crate.
    fn small_png(color: png::ColorType, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 2, 1);
            encoder.set_color(color);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(data).unwrap();
        }
        out
    }

    #[test]
    fn png_in_its_forms() {
        let rgb = small_png(png::ColorType::Rgb, &[255, 0, 0, 0, 0, 255]);
        assert_eq!(
            decode(&rgb),
            Some(Cover {
                width: 2,
                height: 1,
                rgb: vec![255, 0, 0, 0, 0, 255]
            })
        );
        let rgba = small_png(png::ColorType::Rgba, &[255, 0, 0, 9, 0, 0, 255, 9]);
        assert_eq!(decode(&rgba).unwrap().rgb, [255, 0, 0, 0, 0, 255]);
        let grey = small_png(png::ColorType::Grayscale, &[10, 200]);
        assert_eq!(decode(&grey).unwrap().rgb, [10, 10, 10, 200, 200, 200]);
    }

    #[test]
    fn not_an_image() {
        assert_eq!(decode(b"GIF89a"), None);
        assert_eq!(decode(&[0xff, 0xd8, 0xff, 0x00]), None);
        assert_eq!(decode(b"\x89PNG\r\n\x1a\nbroken"), None);
        assert_eq!(rgb_of(vec![1, 2], 2, 1, 3), None);
    }
}
