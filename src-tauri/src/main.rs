#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod icons;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use winreg::enums::*;
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SERVICES_KEY: &str = "SYSTEM\\CurrentControlSet\\Services";

/// Services that must never be touched, whatever the UI asks for.
/// Disabling any of these can leave Windows unbootable or without network/security.
const HARD_BLOCK: &[&str] = &[
    "rpcss", "rpceptmapper", "dcomlaunch", "lsm", "plugplay", "power", "samss", "eventlog",
    "brokerinfrastructure", "systemeventsbroker", "coremessagingregistrar", "gpsvc", "profsvc",
    "usermanager", "staterepository", "keyiso", "bfe", "mpssvc", "cryptsvc", "schedule",
    "winmgmt", "trustedinstaller", "windefend", "securityhealthservice", "wscsvc", "appinfo",
    "dhcp", "dnscache", "nsi", "themes", "shellhwdetection", "timebrokersvc", "audiosrv",
    "audioendpointbuilder", "waasmedicsvc", "lanmanworkstation", "netprofm", "nlasvc",
    "storsvc", "sens", "wcmsvc",
];

fn is_blocked(name: &str) -> bool {
    HARD_BLOCK.contains(&name.to_lowercase().as_str())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ───────────────────────────── scanning ─────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServiceInfo {
    name: String,
    display: String,
    description: String,
    start: u32,
    delayed: bool,
    /// SERVICE_* current state: 1 stopped, 4 running, ...
    state: u32,
    pid: u32,
    image_path: String,
    depends_on: Vec<String>,
    dependents: Vec<String>,
    blocked: bool,
}

/// Resolve "@%SystemRoot%\system32\x.dll,-123" style indirect strings.
fn resolve_indirect(s: &str) -> String {
    if !s.starts_with('@') {
        return s.to_string();
    }
    let src: Vec<u16> = s.encode_utf16().chain(Some(0)).collect();
    let mut buf = [0u16; 1024];
    let hr = unsafe {
        windows_sys::Win32::UI::Shell::SHLoadIndirectString(
            src.as_ptr(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            std::ptr::null_mut(),
        )
    };
    if hr != 0 {
        return String::new();
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n])
}

unsafe fn pwstr_to_string(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut n = 0;
    while *p.add(n) != 0 {
        n += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
}

/// lowercase service name -> (current state, pid)
fn running_map() -> HashMap<String, (u32, u32)> {
    use windows_sys::Win32::System::Services::*;
    let mut out = HashMap::new();
    unsafe {
        let scm = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_ENUMERATE_SERVICE);
        if scm.is_null() {
            return out;
        }
        let mut needed = 0u32;
        let mut count = 0u32;
        let mut resume = 0u32;
        EnumServicesStatusExW(
            scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL,
            std::ptr::null_mut(), 0, &mut needed, &mut count, &mut resume, std::ptr::null(),
        );
        // u64 buffer keeps the structs 8-byte aligned
        let mut buf: Vec<u64> = vec![0; (needed as usize + 65536) / 8 + 1];
        resume = 0;
        loop {
            let ok = EnumServicesStatusExW(
                scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL,
                buf.as_mut_ptr() as *mut u8, (buf.len() * 8) as u32,
                &mut needed, &mut count, &mut resume, std::ptr::null(),
            );
            let p = buf.as_ptr() as *const ENUM_SERVICE_STATUS_PROCESSW;
            for i in 0..count as usize {
                let e = &*p.add(i);
                let name = pwstr_to_string(e.lpServiceName).to_lowercase();
                out.insert(name, (e.ServiceStatusProcess.dwCurrentState, e.ServiceStatusProcess.dwProcessId));
            }
            if ok != 0 || resume == 0 {
                break;
            }
        }
        CloseServiceHandle(scm);
    }
    out
}

fn read_cfg(key: &RegKey) -> Option<(u32, u32, bool)> {
    let typ: u32 = key.get_value("Type").unwrap_or(0);
    let start: u32 = key.get_value("Start").ok()?;
    let delayed: u32 = key.get_value("DelayedAutostart").unwrap_or(0);
    Some((typ, start, delayed == 1))
}

#[tauri::command]
async fn scan_services() -> Result<Vec<ServiceInfo>, String> {
    scan_impl()
}

fn scan_impl() -> Result<Vec<ServiceInfo>, String> {
    let root = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(SERVICES_KEY)
        .map_err(|e| e.to_string())?;
    let states = running_map();
    let mut list: Vec<ServiceInfo> = Vec::new();

    for name in root.enum_keys().flatten() {
        let Ok(k) = root.open_subkey(&name) else { continue };
        let Some((typ, start, delayed)) = read_cfg(&k) else { continue };
        // keep Win32 services only: skip kernel/file-system drivers and per-user instances
        if typ & 0x30 == 0 || typ & 0x80 != 0 {
            continue;
        }
        let display_raw: String = k.get_value("DisplayName").unwrap_or_default();
        let mut display = resolve_indirect(&display_raw);
        if display.is_empty() {
            display = name.clone();
        }
        let desc_raw: String = k.get_value("Description").unwrap_or_default();
        let description = resolve_indirect(&desc_raw);
        let image_path: String = k.get_value("ImagePath").unwrap_or_default();
        let depends_on: Vec<String> = k
            .get_value::<Vec<String>, _>("DependOnService")
            .unwrap_or_default()
            .into_iter()
            .filter(|d| !d.starts_with('+') && !d.is_empty())
            .collect();
        let (state, pid) = states.get(&name.to_lowercase()).copied().unwrap_or((1, 0));
        list.push(ServiceInfo {
            blocked: is_blocked(&name),
            name, display, description, start, delayed, state, pid, image_path,
            depends_on, dependents: Vec::new(),
        });
    }

    // invert the dependency graph
    let mut rev: HashMap<String, Vec<String>> = HashMap::new();
    for s in &list {
        for d in &s.depends_on {
            rev.entry(d.to_lowercase()).or_default().push(s.name.clone());
        }
    }
    for s in &mut list {
        if let Some(v) = rev.get(&s.name.to_lowercase()) {
            s.dependents = v.clone();
        }
    }
    list.sort_by(|a, b| a.display.to_lowercase().cmp(&b.display.to_lowercase()));
    Ok(list)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SysInfo {
    os: String,
    version: String,
    ram_total: u64,
    ram_used_pct: u32,
}

#[tauri::command]
async fn system_info() -> SysInfo {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let cv = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion").ok();
    let get = |n: &str| cv.as_ref().and_then(|k| k.get_value::<String, _>(n).ok()).unwrap_or_default();
    let build: u32 = get("CurrentBuild").parse().unwrap_or(0);
    let mut os = get("ProductName");
    // ProductName still says "Windows 10" on Windows 11
    if build >= 22000 {
        os = os.replace("Windows 10", "Windows 11");
    }
    let mut ms: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    ms.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut ms) } != 0;
    SysInfo {
        os,
        version: get("DisplayVersion"),
        ram_total: if ok { ms.ullTotalPhys } else { 0 },
        ram_used_pct: if ok { ms.dwMemoryLoad } else { 0 },
    }
}

/// Icons of autostart entries / service executables as PNG data URLs.
/// The UI only sends ids; the file paths come from our own scans, never from the UI.
#[tauri::command]
async fn entry_icons(kind: String, ids: Vec<String>) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        icons::init_thread();
        let wanted: std::collections::HashSet<&String> = ids.iter().collect();
        let targets: Vec<(String, String)> = match kind.as_str() {
            "startup" => scan_startup_impl().into_iter().filter(|e| wanted.contains(&e.id)).map(|e| (e.id, e.command)).collect(),
            "service" => scan_impl()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| wanted.contains(&s.name) && !s.image_path.to_lowercase().contains("svchost.exe"))
                .map(|s| (s.name, s.image_path))
                .collect(),
            _ => Vec::new(),
        };
        let mut out = HashMap::new();
        for (id, cmd) in targets {
            if let Some(url) = icons::resolve_exe(&cmd).and_then(|p| icons::icon_data_url(&p)) {
                out.insert(id, url);
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    build: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION"), build: env!("WINLITE_BUILD") }
}

/// Opens a web search in the default browser. Only known search-engine URLs are allowed.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    const ALLOWED: &[&str] = &["https://duckduckgo.com/?q=", "https://www.google.com/search?q=", "https://www.bing.com/search?q="];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) || url.len() > 600 || url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("Адрес не разрешён".into());
    }
    let w = |s: &str| -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() };
    let (op, target) = (w("open"), w(&url));
    let r = unsafe {
        windows_sys::Win32::UI::Shell::ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), 1)
    };
    if (r as isize) > 32 { Ok(()) } else { Err("Не удалось открыть браузер".into()) }
}

#[tauri::command]
fn is_admin() -> bool {
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}

// ───────────────────────────── snapshots ─────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SnapItem {
    name: String,
    display: String,
    before_start: u32,
    before_delayed: bool,
    before_running: bool,
    after: String,
    ok: bool,
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TweakItem {
    id: String,
    hive: String,
    path: String,
    name: String,
    /// None = the value did not exist before (restore deletes it)
    before: Option<u32>,
    after: u32,
    ok: bool,
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    id: String,
    created: u64,
    restore_point: bool,
    #[serde(default)]
    restore_status: String,
    restored: Option<u64>,
    items: Vec<SnapItem>,
    #[serde(default)]
    tweaks: Vec<TweakItem>,
    #[serde(default)]
    startup: Vec<StartupSnap>,
}

// ───────────────────────────── autostart ─────────────────────────────
// Entries are enabled/disabled the same way Task Manager does it: the StartupApproved registry
// keys. Nothing is deleted, so the original Run value / shortcut stays intact and is reversible.

const RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_PATH_32: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartupEntry {
    id: String,
    name: String,
    command: String,
    location: String,
    enabled: bool,
    machine: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartupSnap {
    id: String,
    name: String,
    before_enabled: bool,
    after_enabled: bool,
    ok: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
struct StartupChange {
    id: String,
    enabled: bool,
}

/// kind -> (hive, StartupApproved sub-key)
fn approved_loc(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "hkcu_run" => Some(("HKCU", "Run")),
        "hklm_run" => Some(("HKLM", "Run")),
        "hklm_run32" => Some(("HKLM", "Run32")),
        "folder_user" => Some(("HKCU", "StartupFolder")),
        "folder_common" => Some(("HKLM", "StartupFolder")),
        _ => None,
    }
}

fn approved_enabled(hive: &str, sub: &str, name: &str) -> bool {
    let Ok(k) = hive_key(hive).open_subkey(format!(r"{APPROVED}\{sub}")) else { return true };
    match k.get_raw_value(name) {
        // first byte: 02/06 = enabled, 03/07 = disabled by the user
        Ok(rv) => rv.bytes.first().map(|b| b & 1 == 0).unwrap_or(true),
        Err(_) => true,
    }
}

fn scan_startup_impl() -> Vec<StartupEntry> {
    let mut out = Vec::new();
    let runs: [(&str, &str, &str, &str); 3] = [
        ("hkcu_run", "Реестр · текущий пользователь", "HKCU", RUN_PATH),
        ("hklm_run", "Реестр · все пользователи", "HKLM", RUN_PATH),
        ("hklm_run32", "Реестр · 32-бит, все пользователи", "HKLM", RUN_PATH_32),
    ];
    for (kind, label, hive, path) in runs {
        let Ok(k) = hive_key(hive).open_subkey(path) else { continue };
        let (ah, asub) = approved_loc(kind).unwrap();
        for (name, _) in k.enum_values().flatten() {
            if name.is_empty() {
                continue;
            }
            let command: String = k.get_value(&name).unwrap_or_default();
            out.push(StartupEntry {
                id: format!("{kind}|{name}"), enabled: approved_enabled(ah, asub, &name),
                name, command, location: label.into(), machine: hive == "HKLM",
            });
        }
    }
    let folders = [
        ("folder_user", "Папка автозагрузки · пользователь", std::env::var("APPDATA").ok().map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs\Startup")), false),
        ("folder_common", "Папка автозагрузки · все пользователи", std::env::var("ProgramData").ok().map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs\StartUp")), true),
    ];
    for (kind, label, dir, machine) in folders {
        let Some(dir) = dir else { continue };
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let (ah, asub) = approved_loc(kind).unwrap();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case("desktop.ini") || !e.path().is_file() {
                continue;
            }
            out.push(StartupEntry {
                id: format!("{kind}|{name}"), enabled: approved_enabled(ah, asub, &name),
                command: e.path().display().to_string(), name, location: label.into(), machine,
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn set_startup(kind: &str, name: &str, enabled: bool) -> Result<(), String> {
    let (hive, sub) = approved_loc(kind).ok_or("Неизвестный тип элемента")?;
    let (k, _) = hive_key(hive).create_subkey(format!(r"{APPROVED}\{sub}")).map_err(|e| e.to_string())?;
    let mut bytes = vec![0u8; 12];
    if enabled {
        bytes[0] = 2;
    } else {
        bytes[0] = 3;
        let ft = (now_secs() + 11_644_473_600) * 10_000_000; // FILETIME, like Task Manager writes
        bytes[4..12].copy_from_slice(&ft.to_le_bytes());
    }
    k.set_raw_value(name, &winreg::RegValue { bytes, vtype: REG_BINARY })
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_startup() -> Result<Vec<StartupEntry>, String> {
    Ok(scan_startup_impl())
}

// ───────────────────────────── registry tweaks ─────────────────────────────
// Whitelist of DWORD registry values WinLite may change. The UI only sends tweak ids.

struct TweakVal {
    hive: &'static str,
    path: &'static str,
    name: &'static str,
    data: u32,
}
struct Tweak {
    id: &'static str,
    vals: &'static [TweakVal],
}
const fn v(hive: &'static str, path: &'static str, name: &'static str, data: u32) -> TweakVal {
    TweakVal { hive, path, name, data }
}

const CDM: &str = r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager";
const POL_DC: &str = r"SOFTWARE\Policies\Microsoft\Windows\DataCollection";
const POL_SYS: &str = r"SOFTWARE\Policies\Microsoft\Windows\System";
const POL_CC: &str = r"SOFTWARE\Policies\Microsoft\Windows\CloudContent";
const POL_APPCOMPAT: &str = r"SOFTWARE\Policies\Microsoft\Windows\AppCompat";
const POL_SEARCH: &str = r"SOFTWARE\Policies\Microsoft\Windows\Windows Search";

static TWEAKS: &[Tweak] = &[
    // ── реклама ──
    Tweak { id: "ads_id", vals: &[
        v("HKCU", r"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo", "Enabled", 0),
        v("HKLM", r"SOFTWARE\Policies\Microsoft\Windows\AdvertisingInfo", "DisabledByGroupPolicy", 1),
    ]},
    Tweak { id: "ads_start", vals: &[
        v("HKCU", CDM, "SubscribedContent-338388Enabled", 0),
        v("HKCU", CDM, "SubscribedContent-338389Enabled", 0),
        v("HKCU", CDM, "SubscribedContent-310093Enabled", 0),
        v("HKCU", CDM, "SystemPaneSuggestionsEnabled", 0),
    ]},
    Tweak { id: "ads_settings", vals: &[
        v("HKCU", CDM, "SubscribedContent-338393Enabled", 0),
        v("HKCU", CDM, "SubscribedContent-353694Enabled", 0),
        v("HKCU", CDM, "SubscribedContent-353696Enabled", 0),
    ]},
    Tweak { id: "ads_lock", vals: &[
        v("HKCU", CDM, "RotatingLockScreenOverlayEnabled", 0),
        v("HKCU", CDM, "SubscribedContent-338387Enabled", 0),
        v("HKCU", POL_CC, "DisableWindowsSpotlightOnActionCenter", 1),
    ]},
    Tweak { id: "ads_apps", vals: &[
        v("HKCU", CDM, "SilentInstalledAppsEnabled", 0),
        v("HKCU", CDM, "PreInstalledAppsEnabled", 0),
        v("HKCU", CDM, "OemPreInstalledAppsEnabled", 0),
        v("HKCU", CDM, "PreInstalledAppsEverEnabled", 0),
        v("HKCU", CDM, "ContentDeliveryAllowed", 0),
        v("HKCU", CDM, "SoftLandingEnabled", 0),
        v("HKLM", POL_CC, "DisableWindowsConsumerFeatures", 1),
    ]},
    Tweak { id: "ads_explorer", vals: &[
        v("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "ShowSyncProviderNotifications", 0),
    ]},
    Tweak { id: "ads_setup", vals: &[
        v("HKCU", r"Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement", "ScoobeSystemSettingEnabled", 0),
    ]},
    // ── трекеры и телеметрия ──
    Tweak { id: "tel_core", vals: &[
        v("HKLM", POL_DC, "AllowTelemetry", 0),
        v("HKLM", POL_DC, "DoNotShowFeedbackNotifications", 1),
    ]},
    Tweak { id: "tel_tailored", vals: &[
        v("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Privacy", "TailoredExperiencesWithDiagnosticDataEnabled", 0),
        v("HKCU", POL_CC, "DisableTailoredExperiencesWithDiagnosticData", 1),
    ]},
    Tweak { id: "tel_errors", vals: &[
        v("HKLM", r"SOFTWARE\Policies\Microsoft\Windows\Windows Error Reporting", "Disabled", 1),
    ]},
    Tweak { id: "tel_appcompat", vals: &[
        v("HKLM", POL_APPCOMPAT, "AITEnable", 0),
        v("HKLM", POL_APPCOMPAT, "DisableInventory", 1),
    ]},
    Tweak { id: "tel_activity", vals: &[
        v("HKLM", POL_SYS, "PublishUserActivities", 0),
        v("HKLM", POL_SYS, "UploadUserActivities", 0),
        v("HKLM", POL_SYS, "EnableActivityFeed", 0),
    ]},
    Tweak { id: "tel_input", vals: &[
        v("HKCU", r"Software\Microsoft\Input\TIPC", "Enabled", 0),
    ]},
    Tweak { id: "tel_feedback", vals: &[
        v("HKCU", r"Software\Microsoft\Siuf\Rules", "NumberOfSIUFInPeriod", 0),
    ]},
    Tweak { id: "tel_lang", vals: &[
        v("HKCU", r"Control Panel\International\User Profile", "HttpAcceptLanguageOptOut", 1),
    ]},
    Tweak { id: "tel_search", vals: &[
        v("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Search", "BingSearchEnabled", 0),
        v("HKLM", POL_SEARCH, "AllowCortana", 0),
    ]},
];

fn hive_key(h: &str) -> RegKey {
    RegKey::predef(if h == "HKLM" { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER })
}

fn read_dword(hive: &str, path: &str, name: &str) -> Result<Option<u32>, String> {
    let Ok(k) = hive_key(hive).open_subkey(path) else { return Ok(None) };
    match k.get_raw_value(name) {
        Ok(rv) if rv.vtype == REG_DWORD && rv.bytes.len() == 4 => {
            Ok(Some(u32::from_le_bytes([rv.bytes[0], rv.bytes[1], rv.bytes[2], rv.bytes[3]])))
        }
        Ok(_) => Err("Значение имеет неожиданный тип".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_dword(hive: &str, path: &str, name: &str, data: u32) -> Result<(), String> {
    let (k, _) = hive_key(hive).create_subkey(path).map_err(|e| e.to_string())?;
    k.set_value(name, &data).map_err(|e| e.to_string())
}

fn delete_value(hive: &str, path: &str, name: &str) -> Result<(), String> {
    let Ok(k) = hive_key(hive).open_subkey_with_flags(path, KEY_SET_VALUE) else { return Ok(()) };
    match k.delete_value(name) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize)]
struct TweakState {
    id: String,
    applied: bool,
}

fn tweak_states() -> Vec<TweakState> {
    TWEAKS
        .iter()
        .map(|t| TweakState {
            id: t.id.to_string(),
            applied: t.vals.iter().all(|x| read_dword(x.hive, x.path, x.name).ok().flatten() == Some(x.data)),
        })
        .collect()
}

#[tauri::command]
async fn list_tweaks() -> Result<Vec<TweakState>, String> {
    Ok(tweak_states())
}

fn snapshots_dir() -> PathBuf {
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    let d = base.join("WinLite").join("snapshots");
    let _ = fs::create_dir_all(&d);
    d
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())
}

fn save_snapshot(s: &Snapshot) -> Result<(), String> {
    let path = snapshots_dir().join(format!("{}.json", s.id));
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn load_snapshot(id: &str) -> Result<Snapshot, String> {
    if !valid_id(id) {
        return Err("Неверный идентификатор копии".into());
    }
    let txt = fs::read_to_string(snapshots_dir().join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    serde_json::from_str(&txt).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_snapshots() -> Result<Vec<Snapshot>, String> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(snapshots_dir()) {
        for e in rd.flatten() {
            if let Ok(txt) = fs::read_to_string(e.path()) {
                if let Ok(s) = serde_json::from_str::<Snapshot>(&txt) {
                    out.push(s);
                }
            }
        }
    }
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

#[tauri::command]
async fn delete_snapshot(id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Неверный идентификатор копии".into());
    }
    fs::remove_file(snapshots_dir().join(format!("{id}.json"))).map_err(|e| e.to_string())
}

// ───────────────────────────── apply / restore ─────────────────────────────

fn sc(args: &[&str]) -> i32 {
    Command::new("sc.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.code().unwrap_or(-1))
        .unwrap_or(-1)
}

fn sc_error(code: i32) -> String {
    match code {
        5 => "Отказано в доступе: служба защищена системой или нет прав администратора".into(),
        1060 => "Служба не найдена".into(),
        1072 => "Служба помечена на удаление".into(),
        87 => "Неверный параметр".into(),
        -1 => "Не удалось запустить sc.exe".into(),
        c => format!("sc.exe вернул код {c}"),
    }
}

fn start_arg(start: u32, delayed: bool) -> Option<&'static str> {
    match (start, delayed) {
        (2, true) => Some("delayed-auto"),
        (2, false) => Some("auto"),
        (3, _) => Some("demand"),
        (4, _) => Some("disabled"),
        _ => None,
    }
}

fn target_arg(target: &str) -> Option<&'static str> {
    match target {
        "auto" => Some("auto"),
        "delayed" => Some("delayed-auto"),
        "manual" => Some("demand"),
        "disabled" => Some("disabled"),
        _ => None,
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ' '))
}

/// Tries to create a Windows restore point and VERIFIES that a new one really appeared.
/// Windows silently skips Checkpoint-Computer when a point was already made in the last 24 h
/// (and still reports success), so the exit code alone is not trustworthy.
/// Returns "created" | "skipped" | "failed".
fn make_restore_point() -> &'static str {
    const SCRIPT: &str = "$ErrorActionPreference='Stop'; try { \
        $b = [int](Get-ComputerRestorePoint | Measure-Object SequenceNumber -Maximum).Maximum; \
        Checkpoint-Computer -Description 'WinLite before changes' -RestorePointType MODIFY_SETTINGS -WarningAction SilentlyContinue; \
        $a = [int](Get-ComputerRestorePoint | Measure-Object SequenceNumber -Maximum).Maximum; \
        if ($a -gt $b) { 'WL_CREATED' } else { 'WL_SKIPPED' } } catch { 'WL_FAILED' }";
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            if s.contains("WL_CREATED") { "created" } else if s.contains("WL_SKIPPED") { "skipped" } else { "failed" }
        }
        Err(_) => "failed",
    }
}

#[derive(Deserialize)]
struct Change {
    name: String,
    /// auto | delayed | manual | disabled
    start: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyResult {
    snapshot_id: String,
    restore_point: bool,
    /// "off" (not requested) | "created" | "skipped" | "failed"
    restore_status: String,
    items: Vec<SnapItem>,
    tweaks: Vec<TweakItem>,
    startup: Vec<StartupSnap>,
}

#[tauri::command]
async fn apply_changes(changes: Vec<Change>, tweaks: Vec<String>, startup: Vec<StartupChange>, restore_point: bool) -> Result<ApplyResult, String> {
    if !is_admin() {
        return Err("Нужны права администратора. Запустите WinLite от имени администратора.".into());
    }
    if changes.is_empty() && tweaks.is_empty() && startup.is_empty() {
        return Err("Нет изменений для применения".into());
    }

    let root = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(SERVICES_KEY)
        .map_err(|e| e.to_string())?;
    let states = running_map();
    let displays: HashMap<String, String> =
        scan_impl()?.into_iter().map(|s| (s.name.to_lowercase(), s.display)).collect();

    // 1. plan: capture the "before" state of every service we are about to touch
    let mut items: Vec<SnapItem> = Vec::new();
    for c in &changes {
        let mut item = SnapItem {
            name: c.name.clone(),
            display: displays.get(&c.name.to_lowercase()).cloned().unwrap_or_else(|| c.name.clone()),
            before_start: 3, before_delayed: false, before_running: false,
            after: c.start.clone(), ok: false, error: None,
        };
        if !valid_name(&c.name) {
            item.error = Some("Недопустимое имя службы".into());
        } else if is_blocked(&c.name) {
            item.error = Some("Служба входит в защищённый список и не изменяется".into());
        } else if target_arg(&c.start).is_none() {
            item.error = Some("Неизвестный режим запуска".into());
        } else if let Some((typ, start, delayed)) = root.open_subkey(&c.name).ok().as_ref().and_then(read_cfg) {
            if typ & 0x30 == 0 {
                item.error = Some("Это не служба Win32 (драйвер?)".into());
            } else {
                item.before_start = start;
                item.before_delayed = delayed;
                item.before_running = states.get(&c.name.to_lowercase()).map(|s| s.0 == 4).unwrap_or(false);
            }
        } else {
            item.error = Some("Служба не найдена".into());
        }
        items.push(item);
    }

    // 1b. plan registry tweaks (whitelisted ids only), remembering the previous values
    let mut tweak_items: Vec<TweakItem> = Vec::new();
    for id in &tweaks {
        let Some(t) = TWEAKS.iter().find(|t| t.id == id) else {
            tweak_items.push(TweakItem {
                id: id.clone(), hive: String::new(), path: String::new(), name: String::new(),
                before: None, after: 0, ok: false, error: Some("Неизвестный твик".into()),
            });
            continue;
        };
        for x in t.vals {
            let (before, error) = match read_dword(x.hive, x.path, x.name) {
                Ok(b) => (b, None),
                Err(e) => (None, Some(e)),
            };
            tweak_items.push(TweakItem {
                id: t.id.into(), hive: x.hive.into(), path: x.path.into(), name: x.name.into(),
                before, after: x.data, ok: false, error,
            });
        }
    }

    // 1c. plan autostart changes: only entries that really exist right now can be touched
    let current_startup = scan_startup_impl();
    let mut startup_items: Vec<StartupSnap> = Vec::new();
    for c in &startup {
        let mut it = StartupSnap { id: c.id.clone(), name: String::new(), before_enabled: true, after_enabled: c.enabled, ok: false, error: None };
        match current_startup.iter().find(|e| e.id == c.id) {
            Some(e) => { it.name = e.name.clone(); it.before_enabled = e.enabled; }
            None => it.error = Some("Элемент автозагрузки не найден".into()),
        }
        startup_items.push(it);
    }

    // 2. safety net: Windows restore point + our own snapshot, written BEFORE any change
    let rp_status = if restore_point { make_restore_point() } else { "off" };
    let rp = rp_status == "created";
    let created = now_secs();
    let mut snap = Snapshot {
        id: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0).to_string(),
        created,
        restore_point: rp,
        restore_status: rp_status.to_string(),
        restored: None,
        items,
        tweaks: tweak_items,
        startup: startup_items,
    };
    save_snapshot(&snap)?;

    // 3. apply
    for item in snap.items.iter_mut() {
        if item.error.is_some() {
            continue;
        }
        let arg = target_arg(&item.after).unwrap();
        let code = sc(&["config", &item.name, "start=", arg]);
        if code != 0 {
            item.error = Some(sc_error(code));
            continue;
        }
        item.ok = true;
        if item.after == "disabled" && item.before_running {
            let _ = sc(&["stop", &item.name]); // best effort; may be refused if dependents run
        }
    }
    for tw in snap.tweaks.iter_mut() {
        if tw.error.is_some() {
            continue;
        }
        match write_dword(&tw.hive, &tw.path, &tw.name, tw.after) {
            Ok(()) => tw.ok = true,
            Err(e) => tw.error = Some(e),
        }
    }
    for st in snap.startup.iter_mut() {
        if st.error.is_some() {
            continue;
        }
        let Some((kind, name)) = st.id.split_once('|') else { continue };
        match set_startup(kind, name, st.after_enabled) {
            Ok(()) => st.ok = true,
            Err(e) => st.error = Some(e),
        }
    }
    save_snapshot(&snap)?;

    Ok(ApplyResult { snapshot_id: snap.id, restore_point: rp, restore_status: rp_status.to_string(), items: snap.items, tweaks: snap.tweaks, startup: snap.startup })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreResult {
    restored: u32,
    failed: Vec<String>,
}

#[tauri::command]
async fn restore_snapshot(id: String) -> Result<RestoreResult, String> {
    if !is_admin() {
        return Err("Нужны права администратора. Запустите WinLite от имени администратора.".into());
    }
    let mut snap = load_snapshot(&id)?;
    let mut restored = 0;
    let mut failed = Vec::new();
    for item in &snap.items {
        if !valid_name(&item.name) || is_blocked(&item.name) {
            continue;
        }
        let Some(arg) = start_arg(item.before_start, item.before_delayed) else { continue };
        let code = sc(&["config", &item.name, "start=", arg]);
        if code != 0 {
            failed.push(format!("{}: {}", item.display, sc_error(code)));
            continue;
        }
        restored += 1;
        if item.before_start == 2 && item.before_running {
            let _ = sc(&["start", &item.name]); // best effort
        }
    }
    for tw in &snap.tweaks {
        if !tw.ok {
            continue;
        }
        let res = match tw.before {
            Some(b) => write_dword(&tw.hive, &tw.path, &tw.name, b),
            None => delete_value(&tw.hive, &tw.path, &tw.name),
        };
        match res {
            Ok(()) => restored += 1,
            Err(e) => failed.push(format!("{} ({}): {}", tw.id, tw.name, e)),
        }
    }
    for st in &snap.startup {
        if !st.ok {
            continue;
        }
        let Some((kind, name)) = st.id.split_once('|') else { continue };
        match set_startup(kind, name, st.before_enabled) {
            Ok(()) => restored += 1,
            Err(e) => failed.push(format!("{}: {}", st.name, e)),
        }
    }
    snap.restored = Some(now_secs());
    save_snapshot(&snap)?;
    Ok(RestoreResult { restored, failed })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            is_admin, app_info, entry_icons, open_url, system_info, scan_startup, scan_services, list_tweaks, apply_changes, list_snapshots, restore_snapshot, delete_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running WinLite");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_reads_real_services() {
        let list = scan_impl().expect("scan");
        println!("services: {}", list.len());
        let running = list.iter().filter(|s| s.state == 4).count();
        println!("running: {running}");
        assert!(list.len() > 50);
        assert!(running > 10);
        let dnscache = list.iter().find(|s| s.name.eq_ignore_ascii_case("dnscache")).expect("Dnscache");
        assert!(dnscache.blocked);
        let tw = tweak_states();
        println!("tweaks: {}", tw.iter().map(|t| format!("{}={}", t.id, t.applied)).collect::<Vec<_>>().join(" "));
        assert_eq!(tw.len(), TWEAKS.len());
        let st = scan_startup_impl();
        for e in &st {
            println!("startup: [{}] {} | enabled={} | {}", e.id, e.name, e.enabled, e.command.chars().take(70).collect::<String>());
        }
        assert!(st.iter().all(|e| e.id.contains('|')));
        // icon extraction: report which entries resolved to an icon and dump the first PNG for a visual check
        icons::init_thread();
        let mut found = 0;
        for e in &st {
            let url = icons::resolve_exe(&e.command).and_then(|p| icons::icon_data_url(&p));
            println!("icon: {} -> {}", e.name, url.as_ref().map(|u| format!("ok ({} bytes)", u.len())).unwrap_or_else(|| "none".into()));
            if let (Some(u), 0) = (&url, found) {
                use base64::Engine;
                let b = base64::engine::general_purpose::STANDARD.decode(u.trim_start_matches("data:image/png;base64,")).unwrap();
                std::fs::write(std::env::temp_dir().join("winlite-icon-test.png"), b).unwrap();
            }
            if url.is_some() { found += 1; }
        }
        assert!(found > 0, "no icons could be extracted");
        for s in list.iter().take(8) {
            println!("{} | {} | start={} state={} | {}", s.name, s.display, s.start, s.state, s.description.chars().take(60).collect::<String>());
        }
    }
}
