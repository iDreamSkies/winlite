//! Extracts the shell icon of an executable / shortcut and returns it as a PNG data URL.
//! Read-only: it only asks Windows for the icon the Explorer would show.

use base64::Engine;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

/// Call once per worker thread before extracting icons (shortcuts need COM).
pub fn init_thread() {
    unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
}

/// Expands %VAR% references (case-insensitive, like Windows).
fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        match tail.find('%') {
            Some(j) => {
                let name = &tail[..j];
                match std::env::var(name) {
                    Ok(v) if !name.is_empty() => out.push_str(&v),
                    _ => { out.push('%'); out.push_str(name); out.push('%'); }
                }
                rest = &tail[j + 1..];
            }
            None => { out.push('%'); rest = tail; }
        }
    }
    out.push_str(rest);
    out
}

/// Finds the executable inside a Run-key style command line:
/// `"C:\a b\x.exe" -arg`, `C:\a b\x.exe -arg` (unquoted with spaces), `%windir%\x.exe`.
pub fn resolve_exe(cmd: &str) -> Option<PathBuf> {
    let mut s = cmd.trim().to_string();
    if let Some(rest) = s.strip_prefix(r"\SystemRoot") { s = format!("%SystemRoot%{rest}"); }
    let s = expand_env(&s);
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('"') {
        let end = rest.find('"')?;
        let p = PathBuf::from(&rest[..end]);
        return p.is_file().then_some(p);
    }
    if Path::new(s).is_file() {
        return Some(PathBuf::from(s));
    }
    // unquoted path with spaces and arguments: the shortest prefix that is an existing file
    for (i, c) in s.char_indices() {
        if c == ' ' {
            let p = PathBuf::from(&s[..i]);
            if p.is_file() { return Some(p); }
        }
    }
    None
}

fn wide(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// PNG data URL with the file's icon, or None.
pub fn icon_data_url(path: &Path) -> Option<String> {
    unsafe {
        let mut sfi: SHFILEINFOW = std::mem::zeroed();
        let p = wide(path);
        let r = SHGetFileInfoW(p.as_ptr(), FILE_ATTRIBUTE_NORMAL, &mut sfi, std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON);
        if r == 0 || sfi.hIcon.is_null() {
            return None;
        }
        let png = hicon_to_png(sfi.hIcon);
        DestroyIcon(sfi.hIcon);
        png.map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
    }
}

unsafe fn dib_pixels(hdc: *mut c_void, hbm: *mut c_void, w: i32, h: i32) -> Option<Vec<u8>> {
    let mut bi: BITMAPINFO = std::mem::zeroed();
    bi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0,
        biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let lines = GetDIBits(hdc, hbm, 0, h as u32, buf.as_mut_ptr() as *mut c_void, &mut bi, DIB_RGB_COLORS);
    (lines != 0).then_some(buf)
}

unsafe fn hicon_to_png(hicon: *mut c_void) -> Option<Vec<u8>> {
    let mut ii: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut ii) == 0 {
        return None;
    }
    let result = (|| {
        if ii.hbmColor.is_null() {
            return None;
        }
        let mut bmp: BITMAP = std::mem::zeroed();
        GetObjectW(ii.hbmColor, std::mem::size_of::<BITMAP>() as i32, &mut bmp as *mut BITMAP as *mut c_void);
        let (w, h) = (bmp.bmWidth, bmp.bmHeight);
        if w <= 0 || h <= 0 || w > 512 || h > 512 {
            return None;
        }
        let hdc = GetDC(std::ptr::null_mut());
        let mut px = dib_pixels(hdc, ii.hbmColor, w, h);
        // old icons have no alpha channel: derive transparency from the mask bitmap
        if let Some(buf) = px.as_mut() {
            if buf.chunks_exact(4).all(|p| p[3] == 0) {
                let mask = if ii.hbmMask.is_null() { None } else { dib_pixels(hdc, ii.hbmMask, w, h) };
                for (i, p) in buf.chunks_exact_mut(4).enumerate() {
                    let opaque = mask.as_ref().map(|m| m[i * 4] == 0).unwrap_or(true);
                    p[3] = if opaque { 255 } else { 0 };
                }
            }
        }
        ReleaseDC(std::ptr::null_mut(), hdc);
        let mut rgba = px?;
        for p in rgba.chunks_exact_mut(4) {
            p.swap(0, 2); // BGRA -> RGBA
        }
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut wr = enc.write_header().ok()?;
            wr.write_image_data(&rgba).ok()?;
        }
        Some(out)
    })();
    if !ii.hbmColor.is_null() { DeleteObject(ii.hbmColor); }
    if !ii.hbmMask.is_null() { DeleteObject(ii.hbmMask); }
    result
}
