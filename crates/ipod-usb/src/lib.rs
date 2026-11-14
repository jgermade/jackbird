//! The iPod on USB: the Apple devices connected, and `SysInfoExtended` read
//! with the iPod's vendor request.
//!
//! The request (the one libgpod uses) targets the device, not an interface,
//! so it works while the system has the iPod mounted as a disk:
//! `bmRequestType 0xC0` (vendor, device to host), `bRequest 0x40`,
//! `wValue 2`, `wIndex` the page, 4096 bytes a page until a short one. Through
//! `nusb`, with no unsafe code here. On Windows `nusb` cannot make a control
//! transfer without claiming an interface, which the mass-storage driver
//! holds, so [`read_sysinfo_extended`] fails there and the copy on the disk is
//! the way. See `RECORD/2026-11-14.ipod-sync.WIP.md`.

use std::fmt;

use jackbird_ipod::device::{APPLE_VENDOR_ID, Generation};

/// An Apple device on USB.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsbIpod {
    /// Its USB product ID.
    pub product_id: u16,
    /// The generation that product ID belongs to, when it is an iPod in disk mode.
    pub generation: Option<Generation>,
    /// Its serial number (the iPods here start it with their FireWire GUID).
    pub serial: Option<String>,
    /// The product name it reports.
    pub product: Option<String>,
    id: nusb::DeviceId,
}

/// Why USB could not be read.
#[derive(Debug)]
pub enum UsbError {
    /// Listing or opening the device failed (permissions on Linux, among others).
    Open(nusb::Error),
    /// The request failed.
    Transfer(String),
    /// The device is no longer connected.
    Gone,
    /// The answer was not text.
    NotText,
    /// This system cannot make the request (Windows).
    Unsupported,
}

impl fmt::Display for UsbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UsbError::Open(e) => write!(f, "could not open the device: {e}"),
            UsbError::Transfer(e) => write!(f, "the request failed: {e}"),
            UsbError::Gone => write!(f, "the device is no longer connected"),
            UsbError::NotText => write!(f, "the answer was not UTF-8 text"),
            UsbError::Unsupported => write!(f, "this system cannot send the request while the disk is mounted"),
        }
    }
}

impl std::error::Error for UsbError {}

/// The Apple devices connected, iPods in disk mode first.
pub fn list_apple_devices() -> Result<Vec<UsbIpod>, UsbError> {
    use nusb::MaybeFuture;
    let mut out: Vec<UsbIpod> = nusb::list_devices()
        .wait()
        .map_err(UsbError::Open)?
        .filter(|d| d.vendor_id() == APPLE_VENDOR_ID)
        .map(|d| UsbIpod {
            product_id: d.product_id(),
            generation: Generation::from_usb_product(d.product_id()),
            serial: d.serial_number().map(str::to_string),
            product: d.product_string().map(str::to_string),
            id: d.id(),
        })
        .collect();
    out.sort_by_key(|d| d.generation.is_none());
    Ok(out)
}

/// The most pages read: 256 KB, far above any `SysInfoExtended`.
const MAX_PAGES: u16 = 64;
const PAGE: u16 = 0x1000;

/// Reads `SysInfoExtended` from the device, as the iPod's firmware sends it.
pub fn read_sysinfo_extended(device: &UsbIpod) -> Result<String, UsbError> {
    let bytes = read_pages(device)?;
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8(bytes[..end].to_vec()).map_err(|_| UsbError::NotText)
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
fn read_pages(device: &UsbIpod) -> Result<Vec<u8>, UsbError> {
    use nusb::MaybeFuture;
    use nusb::transfer::{ControlIn, ControlType, Recipient};
    use std::time::Duration;

    let info = nusb::list_devices()
        .wait()
        .map_err(UsbError::Open)?
        .find(|d| d.id() == device.id)
        .ok_or(UsbError::Gone)?;
    let handle = info.open().wait().map_err(UsbError::Open)?;
    let mut out = Vec::new();
    for page in 0..MAX_PAGES {
        let data = handle
            .control_in(
                ControlIn {
                    control_type: ControlType::Vendor,
                    recipient: Recipient::Device,
                    request: 0x40,
                    value: 2,
                    index: page,
                    length: PAGE,
                },
                Duration::from_secs(5),
            )
            .wait()
            .map_err(|e| UsbError::Transfer(e.to_string()))?;
        let short = data.len() < usize::from(PAGE);
        out.extend(data);
        if short {
            break;
        }
    }
    Ok(out)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "android")))]
fn read_pages(_device: &UsbIpod) -> Result<Vec<u8>, UsbError> {
    Err(UsbError::Unsupported)
}
