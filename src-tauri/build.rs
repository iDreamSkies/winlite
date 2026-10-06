use std::time::{SystemTime, UNIX_EPOCH};

/// Build stamp YYYYMMDD (UTC), shown in the UI next to the version.
fn build_stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    // civil-from-days (Howard Hinnant)
    let z = secs / 86_400 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}")
}

fn main() {
    println!("cargo:rustc-env=WINLITE_BUILD={}", build_stamp());
    // refresh the stamp when code or UI changes
    println!("cargo:rerun-if-changed=src/main.rs");
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=build.rs");

    // Release builds ask for admin rights (UAC); dev builds run unelevated (read-only scan).
    let mut attrs = tauri_build::Attributes::new();
    if std::env::var("PROFILE").map(|p| p == "release").unwrap_or(false) {
        attrs = attrs.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("winlite.manifest")),
        );
    }
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
