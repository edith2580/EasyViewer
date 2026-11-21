use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, COOKIE, LOCATION};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_fs::FsExt;
use url::Url;

const MAX_BOOK_BYTES: u64 = 256 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const CONNECT_TIMEOUT_SECS: u64 = 10;

#[cfg(desktop)]
#[derive(Default)]
struct AppSecurityState {
    approved_storage_dirs: Mutex<HashSet<PathBuf>>,
    approved_drop_paths: Mutex<HashSet<PathBuf>>,
}

struct PinnedSsrfResolver {
    pinned: Arc<Mutex<HashMap<String, IpAddr>>>,
}

impl reqwest::dns::Resolve for PinnedSsrfResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name
            .as_str()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let ip_opt = self.pinned.lock().ok().and_then(|map| map.get(&host).copied());
        Box::pin(async move {
            match ip_opt {
                Some(ip) => {
                    let addrs: reqwest::dns::Addrs =
                        Box::new(std::iter::once(SocketAddr::new(ip, 0)));
                    Ok(addrs)
                }
                None => Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!("BLOCKED_HIGH_RISK: DNS resolution not pre-pinned for host: {host}"),
                )) as Box<dyn std::error::Error + Send + Sync>),
            }
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpClassification {
    BlockedHighRisk,
    PrivateNetwork,
    Public,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeRemoteFetchRequest {
    pub url: String,
    pub method: String,
    pub headers: Option<HashMap<String, String>>,
    pub body_base64: Option<String>,
    pub allow_private_nas: Option<bool>,
    pub allow_self_signed_tls: Option<bool>,
    pub timeout_ms: Option<u64>,
    pub max_response_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeRemoteFetchResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body_base64: String,
    pub final_url: String,
}

/// Validates and normalizes a storage directory path so relative or `..` traversal paths are rejected.
pub fn validate_storage_dir_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("storage folder path must not be empty".into());
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_absolute() {
        return Err(format!("storage folder must be an absolute path: {path}"));
    }
    for component in dir.components() {
        if matches!(component, Component::ParentDir) {
            return Err(format!("storage folder must not contain '..': {path}"));
        }
    }
    Ok(dir)
}

pub fn classify_ipv4(ip: Ipv4Addr) -> IpClassification {
    let o = ip.octets();
    if o[0] == 0
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || o[0] >= 224
    {
        return IpClassification::BlockedHighRisk;
    }
    let is_cgnat = o[0] == 100 && (64..=127).contains(&o[1]);
    if ip.is_private() || is_cgnat {
        return IpClassification::PrivateNetwork;
    }
    IpClassification::Public
}

pub fn classify_ipv6(ip: Ipv6Addr) -> IpClassification {
    if let Some(mapped_v4) = ip.to_ipv4_mapped() {
        return classify_ipv4(mapped_v4);
    }
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return IpClassification::BlockedHighRisk;
    }
    let seg0 = ip.segments()[0];
    // fe80::/10 link-local
    if (seg0 & 0xffc0) == 0xfe80 {
        return IpClassification::BlockedHighRisk;
    }
    // fc00::/7 Unique Local Address
    if (seg0 & 0xfe00) == 0xfc00 {
        return IpClassification::PrivateNetwork;
    }
    IpClassification::Public
}

pub fn classify_ip(ip: IpAddr) -> IpClassification {
    match ip {
        IpAddr::V4(v4) => classify_ipv4(v4),
        IpAddr::V6(v6) => classify_ipv6(v6),
    }
}

/// Classifies raw IP literals including bracketed IPv6, Zone IDs (`fe80::1%en0`),
/// and octal/decimal/hex IPv4 forms identically to the TS/Node SSRF validators.
pub fn classify_ip_str(raw: &str) -> Result<IpClassification, String> {
    let trimmed = raw
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']');
    let without_zone = trimmed.split('%').next().unwrap_or("");
    if without_zone.is_empty() {
        return Ok(IpClassification::BlockedHighRisk);
    }
    if let Ok(ip) = without_zone.parse::<IpAddr>() {
        return Ok(classify_ip(ip));
    }
    if let Ok(parsed) = Url::parse(&format!("http://{without_zone}")) {
        if let Some(host) = parsed.host() {
            match host {
                url::Host::Ipv4(v4) => return Ok(classify_ipv4(v4)),
                url::Host::Ipv6(v6) => return Ok(classify_ipv6(v6)),
                url::Host::Domain(_) => {}
            }
        }
    }
    Err(format!("INVALID_IP: 해석할 수 없는 IP 리터럴입니다: {raw}"))
}

fn is_allowed_method(method: &str) -> Result<reqwest::Method, String> {
    let upper = method.trim().to_ascii_uppercase();
    match upper.as_str() {
        "GET" | "HEAD" | "OPTIONS" | "PROPFIND" | "POST" => {
            reqwest::Method::from_bytes(upper.as_bytes()).map_err(|e| e.to_string())
        }
        _ => Err(format!("METHOD_NOT_ALLOWED: 허용되지 않은 HTTP 메서드입니다: {upper}")),
    }
}

fn validate_url_syntax(raw_url: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|e| format!("INVALID_URL: 잘못된 URL 형식입니다: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("BLOCKED_SCHEME: 허용되지 않은 프로토콜입니다: {scheme}")),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("INVALID_URL: URL 내 내장 자격 증명은 허용되지 않습니다.".into());
    }
    if parsed.host_str().is_none() {
        return Err("INVALID_URL: 호스트가 지정되지 않았습니다.".into());
    }
    Ok(parsed)
}

fn check_ip_policy(ip: IpAddr, allow_private_nas: bool) -> Result<(), String> {
    match classify_ip(ip) {
        IpClassification::BlockedHighRisk => Err(
            "BLOCKED_HIGH_RISK: 보안 정책에 의해 차단된 내부 네트워크 주소입니다.".into(),
        ),
        IpClassification::PrivateNetwork if !allow_private_nas => Err(
            "PRIVATE_NETWORK_CONFIRM_REQUIRED: 사설 네트워크(NAS) 접근에는 사용자 승인이 필요합니다."
                .into(),
        ),
        _ => Ok(()),
    }
}

fn resolve_and_pin_host(url: &Url, allow_private_nas: bool) -> Result<(String, SocketAddr), String> {
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "INVALID_URL: 포트를 결정할 수 없습니다.".to_string())?;

    let host = url
        .host()
        .ok_or_else(|| "INVALID_URL: 호스트가 없습니다.".to_string())?;

    // Inspect parsed url::Host before OS DNS lookup so bracketed IPv6/octal IPv4 literals classify deterministically.
    let domain = match host {
        url::Host::Ipv4(v4) => {
            let ip = IpAddr::V4(v4);
            check_ip_policy(ip, allow_private_nas)?;
            return Ok((v4.to_string(), SocketAddr::new(ip, port)));
        }
        url::Host::Ipv6(v6) => {
            let ip = IpAddr::V6(v6);
            check_ip_policy(ip, allow_private_nas)?;
            return Ok((v6.to_string(), SocketAddr::new(ip, port)));
        }
        url::Host::Domain(raw_domain) => raw_domain.trim_end_matches('.').to_ascii_lowercase(),
    };

    if domain == "localhost" || domain.ends_with(".localhost") {
        return Err("BLOCKED_HIGH_RISK: 보안 정책에 의해 차단된 내부 네트워크 주소입니다.".into());
    }
    if domain.ends_with(".local") && !allow_private_nas {
        return Err(
            "PRIVATE_NETWORK_CONFIRM_REQUIRED: 사설 네트워크(.local) 접근에는 사용자 승인이 필요합니다."
                .into(),
        );
    }

    let addrs: Vec<SocketAddr> = (domain.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS_RESOLUTION_FAILED: 호스트 주소를 해석할 수 없습니다: {e}"))?
        .collect();

    if addrs.is_empty() {
        return Err("DNS_RESOLUTION_FAILED: 해석된 IP 주소가 없습니다.".into());
    }

    for addr in &addrs {
        check_ip_policy(addr.ip(), allow_private_nas)?;
    }

    Ok((domain, addrs[0]))
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(|h| h.to_ascii_lowercase())
            == b.host_str().map(|h| h.to_ascii_lowercase())
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_supported_book_extension(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(ext.to_ascii_lowercase().as_str(), "txt" | "epub"),
        None => false,
    }
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Strips Windows verbatim prefixes (`\\?\UNC\` -> `\\`, `\\?\` -> ``) so paths
/// from `canonicalize()`, dialogs, drag-drop, and `fs_scope` compare consistently.
fn normalize_windows_verbatim(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if s.len() >= 8 && s[..8].eq_ignore_ascii_case(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", &s[8..]));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Canonicalizes an existing path, falling back to `symlink_metadata` + verbatim
/// normalization on Windows when network shares (SMB/NAS/UNC) reject `GetFinalPathNameByHandleW`.
fn resolve_existing_path(path: &Path) -> Result<PathBuf, std::io::Error> {
    match std::fs::canonicalize(path) {
        Ok(canonical) => Ok(normalize_windows_verbatim(&canonical)),
        Err(err) => {
            #[cfg(windows)]
            {
                if let Ok(meta) = std::fs::symlink_metadata(path) {
                    if !meta.file_type().is_symlink() {
                        return Ok(normalize_windows_verbatim(path));
                    }
                }
            }
            Err(err)
        }
    }
}

fn matches_path_prefix(path: &Path, prefix: &Path, case_insensitive: bool) -> bool {
    if !case_insensitive {
        return path.starts_with(prefix);
    }
    let path_norm = path.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    let prefix_raw = prefix.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    let prefix_norm = prefix_raw.trim_end_matches('/');
    if prefix_norm.is_empty() {
        return path_norm.starts_with('/');
    }
    path_norm == prefix_norm || path_norm.starts_with(&format!("{prefix_norm}/"))
}

/// Checks OS system directories and credential stores with configurable case folding for APFS/NTFS.
pub fn is_sensitive_path_with_case_mode(
    path: &Path,
    home_dir: Option<&Path>,
    case_insensitive: bool,
) -> bool {
    const SYSTEM_DENY_PREFIXES: &[&str] = &[
        "/System",
        "/Library",
        "/etc",
        "/private",
        "/proc",
        "/sys",
        "/dev",
        "/root",
        "/var/root",
        "/var/db",
    ];
    for prefix in SYSTEM_DENY_PREFIXES {
        if matches_path_prefix(path, Path::new(prefix), case_insensitive) {
            return true;
        }
    }

    const CREDENTIAL_DIRS: &[&str] = &[".ssh", ".gnupg", ".aws", ".kube"];
    if let Some(home) = home_dir {
        for sub in CREDENTIAL_DIRS {
            if matches_path_prefix(path, &home.join(sub), case_insensitive) {
                return true;
            }
        }
    }
    for comp in path.components() {
        if let Component::Normal(name) = comp {
            if let Some(s) = name.to_str() {
                let matched = if case_insensitive {
                    CREDENTIAL_DIRS
                        .iter()
                        .any(|dir| s.eq_ignore_ascii_case(dir))
                } else {
                    CREDENTIAL_DIRS.contains(&s)
                };
                if matched {
                    return true;
                }
            }
        }
    }
    false
}

/// Blocks OS system directories and user credential stores regardless of raw/canonical alias.
pub fn is_sensitive_path(path: &Path, home_dir: Option<&Path>) -> bool {
    is_sensitive_path_with_case_mode(
        path,
        home_dir,
        cfg!(any(target_os = "macos", target_os = "windows")),
    )
}

pub fn compute_remaining_budget(deadline: Instant, now: Instant) -> Result<Duration, String> {
    if now >= deadline {
        return Err("TIMEOUT: 원격 요청 총 제한 시간이 초과되었습니다.".into());
    }
    Ok(deadline.saturating_duration_since(now))
}

/// Walks up to the nearest existing ancestor, canonicalizes it to catch symlink escapes before
/// `create_dir_all`, verifies neither ancestor nor created path is sensitive, and returns canonical dir.
pub fn validate_and_prepare_storage_dir(
    raw_path: &str,
    home_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let dir = validate_storage_dir_path(raw_path)?;
    if is_sensitive_path(&dir, home_dir) {
        return Err(format!(
            "SECURITY_DENIED: 시스템 또는 자격 증명 보호 경로는 저장소로 허용되지 않습니다: {raw_path}"
        ));
    }

    let mut ancestor = dir.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or_else(|| {
            format!("SECURITY_DENIED: 유효한 상위 디렉토리를 찾을 수 없습니다: {raw_path}")
        })?;
    }
    let canonical_ancestor = resolve_existing_path(ancestor)
        .map_err(|e| format!("SECURITY_DENIED: 상위 경로 정규화 실패: {e}"))?;
    if is_sensitive_path(&canonical_ancestor, home_dir) {
        return Err(format!(
            "SECURITY_DENIED: 심볼릭 링크를 통한 민감 경로 접근은 차단됩니다: {raw_path}"
        ));
    }

    std::fs::create_dir_all(&dir).map_err(|e| format!("DIR_CREATE_FAILED: {e}"))?;

    let canonical_final = resolve_existing_path(&dir)
        .map_err(|e| format!("SECURITY_DENIED: 생성된 경로 검증 실패: {e}"))?;
    if !canonical_final.is_dir() {
        return Err(format!("INVALID_DIR: 디렉토리가 아닙니다: {raw_path}"));
    }
    if is_sensitive_path(&canonical_final, home_dir) {
        return Err(format!(
            "SECURITY_DENIED: 생성된 경로가 민감 영역으로 해석되어 거부되었습니다: {raw_path}"
        ));
    }
    Ok(canonical_final)
}

/// Enforces Zero-Trust whitelist & deny-list checks before reading a local book file.
pub fn validate_and_read_book_file(
    raw_path: &str,
    max_bytes: Option<u64>,
    approved_dirs: &HashSet<PathBuf>,
    approved_drops: &HashSet<PathBuf>,
    fs_scope_allowed: bool,
    home_dir: Option<&Path>,
) -> Result<Vec<u8>, String> {
    let raw = validate_storage_dir_path(raw_path)?;
    if is_sensitive_path(&raw, home_dir) {
        return Err("SECURITY_DENIED: 시스템 또는 자격 증명 보호 경로는 읽을 수 없습니다.".into());
    }
    if !is_supported_book_extension(&raw) {
        return Err("UNSUPPORTED_FORMAT: .txt 또는 .epub 파일만 열 수 있습니다.".into());
    }

    let canonical = resolve_existing_path(&raw)
        .map_err(|e| format!("FILE_READ_FAILED: 파일 정보를 확인할 수 없습니다: {e}"))?;
    if is_sensitive_path(&canonical, home_dir) {
        return Err("SECURITY_DENIED: 심볼릭 링크 대상이 보호 경로여서 차단되었습니다.".into());
    }
    if !is_supported_book_extension(&canonical) {
        return Err("UNSUPPORTED_FORMAT: 정규화된 대상이 .txt 또는 .epub 파일이 아닙니다.".into());
    }

    let case_insensitive = cfg!(any(target_os = "macos", target_os = "windows"));
    let in_approved_dir = approved_dirs.iter().any(|dir| {
        let norm_dir = normalize_windows_verbatim(dir);
        matches_path_prefix(&canonical, &norm_dir, case_insensitive)
    });
    let in_approved_drop = approved_drops.iter().any(|drop_path| {
        let norm_drop = normalize_windows_verbatim(drop_path);
        if case_insensitive {
            norm_drop
                .to_string_lossy()
                .replace('\\', "/")
                .eq_ignore_ascii_case(&canonical.to_string_lossy().replace('\\', "/"))
        } else {
            norm_drop == canonical
        }
    });
    if !in_approved_dir && !in_approved_drop && !fs_scope_allowed {
        return Err(
            "SECURITY_DENIED: 승인된 저장소, 파일 다이얼로그 또는 드롭 화이트리스트에 없는 파일입니다."
                .into(),
        );
    }

    let metadata = std::fs::metadata(&canonical)
        .map_err(|e| format!("FILE_READ_FAILED: 파일 정보를 확인할 수 없습니다: {e}"))?;
    if !metadata.is_file() {
        return Err("INVALID_FILE: 일반 파일만 읽을 수 있습니다.".into());
    }
    let ceiling = max_bytes.unwrap_or(MAX_BOOK_BYTES).min(MAX_BOOK_BYTES);
    if metadata.len() > ceiling {
        return Err(format!(
            "FILE_TOO_LARGE: 도서 파일 크기가 허용 상한({ceiling} bytes)을 초과했습니다."
        ));
    }
    std::fs::read(&canonical).map_err(|e| format!("FILE_READ_FAILED: {e}"))
}

/// True on Windows/macOS/Linux builds. The storage-folder feature (readable file names, folder
/// open/change) is desktop only; Android/iOS keep storing books internally as before.
#[tauri::command]
fn is_desktop() -> bool {
    cfg!(desktop)
}

/// Returns the compiled target OS (`windows`, `macos`, `linux`, `android`, `ios`).
#[tauri::command]
fn get_platform_os() -> String {
    std::env::consts::OS.to_string()
}

#[cfg(target_os = "windows")]
fn normalize_win_dir_key(path: &Path) -> String {
    normalize_windows_verbatim(path)
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// Checks Windows Registry (NSIS Uninstall key, WiX/MSI InstallDir key, and generic
/// Uninstall subkeys with `DisplayName == EasyViewer`) against the running `exe_dir`.
#[cfg(target_os = "windows")]
fn detect_windows_install_mode_from_registry(exe_dir_key: &str) -> Option<&'static str> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let roots = [
        RegKey::predef(HKEY_CURRENT_USER),
        RegKey::predef(HKEY_LOCAL_MACHINE),
    ];

    // 1. Check NSIS standard Uninstall\EasyViewer key
    for root in &roots {
        if let Ok(key) = root.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyViewer",
            KEY_READ,
        ) {
            if let Ok(loc) = key.get_value::<String, _>("InstallLocation") {
                if normalize_win_dir_key(Path::new(&loc)) == exe_dir_key {
                    return Some("nsis");
                }
            }
        }
    }

    // 2. Check WiX/MSI custom InstallDir registry key written by Tauri's WiX template
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\edith\EasyViewer", KEY_READ)
    {
        if let Ok(loc) = key.get_value::<String, _>("InstallDir") {
            if normalize_win_dir_key(Path::new(&loc)) == exe_dir_key {
                return Some("msi");
            }
        }
    }

    // 3. Scan Uninstall subkeys (covers custom MSI install dirs & ProductCode GUID entries)
    let uninstall_paths = [
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    for root in &roots {
        for base_path in &uninstall_paths {
            let Ok(uninstall_root) = root.open_subkey_with_flags(base_path, KEY_READ) else {
                continue;
            };
            for sub_name in uninstall_root.enum_keys().flatten() {
                let Ok(sub) = uninstall_root.open_subkey_with_flags(&sub_name, KEY_READ) else {
                    continue;
                };
                let Ok(display_name) = sub.get_value::<String, _>("DisplayName") else {
                    continue;
                };
                if !display_name.trim().eq_ignore_ascii_case("EasyViewer") {
                    continue;
                }
                let Ok(loc) = sub.get_value::<String, _>("InstallLocation") else {
                    continue;
                };
                if normalize_win_dir_key(Path::new(&loc)) != exe_dir_key {
                    continue;
                }
                let is_msi = sub
                    .get_value::<u32, _>("WindowsInstaller")
                    .is_ok_and(|v| v == 1)
                    || sub
                        .get_value::<String, _>("UninstallString")
                        .is_ok_and(|s| s.to_ascii_lowercase().contains("msiexec"));
                return Some(if is_msi { "msi" } else { "nsis" });
            }
        }
    }

    None
}

/// Distinguishes Windows installation modes (`nsis`, `msi`, `portable`) by matching
/// the running executable directory against Windows Uninstall/WiX registry entries
/// and the NSIS sibling `uninstall.exe`.
pub fn detect_windows_install_mode(exe_path: &Path) -> &'static str {
    let Some(dir) = exe_path.parent() else {
        return "portable";
    };

    #[cfg(target_os = "windows")]
    {
        let exe_dir_key = normalize_win_dir_key(dir);
        if let Some(mode) = detect_windows_install_mode_from_registry(&exe_dir_key) {
            return mode;
        }
    }

    if dir.join("uninstall.exe").exists() {
        return "nsis";
    }

    "portable"
}

#[tauri::command]
fn get_install_mode() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            return detect_windows_install_mode(&exe).to_string();
        }
        return "portable".to_string();
    }
    #[cfg(not(target_os = "windows"))]
    {
        "standard".to_string()
    }
}

const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/edith2580/EasyViewer/releases/download/";
const ALLOWED_UPDATE_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

pub fn validate_release_download_url(raw_url: &str) -> Result<Url, String> {
    let trimmed = raw_url.trim();
    if !trimmed.starts_with(RELEASE_DOWNLOAD_PREFIX) {
        return Err("SECURITY_DENIED: 허용되지 않은 업데이트 다운로드 출처입니다.".into());
    }
    let parsed = validate_url_syntax(trimmed)?;
    if parsed.scheme() != "https" {
        return Err("SECURITY_DENIED: HTTPS 업데이트 URL만 허용됩니다.".into());
    }
    Ok(parsed)
}

pub fn validate_update_asset_name(asset_name: &str, os: &str) -> Result<String, String> {
    let trimmed = asset_name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains('\0')
    {
        return Err("INVALID_ASSET_NAME: 유효하지 않은 업데이트 파일 이름입니다.".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    let valid_ext = match os {
        "windows" => lower.ends_with(".exe") || lower.ends_with(".msi") || lower.ends_with(".zip"),
        "macos" => lower.ends_with(".dmg"),
        "linux" => lower.ends_with(".appimage") || lower.ends_with(".deb") || lower.ends_with(".rpm"),
        _ => false,
    };
    if !valid_ext {
        return Err(format!(
            "UNSUPPORTED_UPDATE_ASSET: 현재 플랫폼({os})에서 자동 설치를 지원하지 않는 파일입니다: {trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

/// Downloads a verified GitHub Release installer for the current desktop OS and launches it.
#[cfg(desktop)]
#[tauri::command]
async fn install_release_update(
    app: tauri::AppHandle,
    download_url: String,
    asset_name: String,
) -> Result<String, String> {
    let initial_url = validate_release_download_url(&download_url)?;
    let safe_name = validate_update_asset_name(&asset_name, std::env::consts::OS)?;

    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP_CLIENT_ERROR: {e}"))?;

    let mut current_url = initial_url;
    let mut final_response = None;
    for hop in 0..=MAX_REDIRECTS {
        let host = current_url
            .host_str()
            .map(|h| h.to_ascii_lowercase())
            .unwrap_or_default();
        if !ALLOWED_UPDATE_HOSTS.contains(&host.as_str()) {
            return Err(format!(
                "SECURITY_DENIED: 허용되지 않은 업데이트 호스트로 리다이렉트되었습니다: {host}"
            ));
        }
        let resp = client
            .get(current_url.clone())
            .header("User-Agent", "EasyViewer-Updater")
            .send()
            .await
            .map_err(|e| format!("UPDATE_DOWNLOAD_FAILED: 업데이트 다운로드 실패: {e}"))?;

        if resp.status().is_redirection() {
            if hop >= MAX_REDIRECTS {
                return Err("TOO_MANY_REDIRECTS: 업데이트 리다이렉트 횟수를 초과했습니다.".into());
            }
            let location = resp
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "INVALID_REDIRECT: Location 헤더가 없습니다.".to_string())?;
            let next_url = current_url
                .join(location)
                .map_err(|e| format!("INVALID_REDIRECT: {e}"))?;
            if next_url.scheme() != "https" {
                return Err("SECURITY_DENIED: HTTPS가 아닌 업데이트 리다이렉트는 차단됩니다.".into());
            }
            current_url = next_url;
            continue;
        }

        if !resp.status().is_success() {
            return Err(format!(
                "UPDATE_DOWNLOAD_FAILED: 서버 응답 오류 (HTTP {})",
                resp.status().as_u16()
            ));
        }
        final_response = Some(resp);
        break;
    }

    let mut response = final_response
        .ok_or_else(|| "UPDATE_DOWNLOAD_FAILED: 업데이트 응답을 수신하지 못했습니다.".to_string())?;

    if let Some(len) = response.content_length() {
        if len > MAX_BOOK_BYTES {
            return Err("RESPONSE_TOO_LARGE: 업데이트 파일 크기가 허용 상한을 초과했습니다.".into());
        }
    }

    let update_dir = std::env::temp_dir().join("easyviewer-updates");
    std::fs::create_dir_all(&update_dir)
        .map_err(|e| format!("UPDATE_IO_FAILED: 임시 업데이트 폴더 생성 실패: {e}"))?;
    let dest_path = update_dir.join(&safe_name);

    let mut acc = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("UPDATE_DOWNLOAD_FAILED: 다운로드 스트림 오류: {e}"))?
    {
        if (acc.len().saturating_add(chunk.len()) as u64) > MAX_BOOK_BYTES {
            return Err("RESPONSE_TOO_LARGE: 업데이트 파일 크기가 허용 상한을 초과했습니다.".into());
        }
        acc.extend_from_slice(&chunk);
    }

    std::fs::write(&dest_path, &acc)
        .map_err(|e| format!("UPDATE_IO_FAILED: 업데이트 파일 저장 실패: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let lower = safe_name.to_ascii_lowercase();
        if lower.ends_with(".zip") {
            let current_exe = std::env::current_exe()
                .map_err(|e| format!("UPDATE_IO_FAILED: 현재 실행 파일 경로 확인 실패: {e}"))?;
            let extract_dir = update_dir.join("portable-extracted");
            let _ = std::fs::remove_dir_all(&extract_dir);
            std::fs::create_dir_all(&extract_dir)
                .map_err(|e| format!("UPDATE_IO_FAILED: 압축 해제 폴더 생성 실패: {e}"))?;

            let expand_status = std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "Expand-Archive -LiteralPath $env:EV_ZIP_PATH -DestinationPath $env:EV_EXTRACT_DIR -Force",
                ])
                .env("EV_ZIP_PATH", &dest_path)
                .env("EV_EXTRACT_DIR", &extract_dir)
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map_err(|e| format!("UPDATE_EXTRACT_FAILED: 포터블 압축 해제 실패: {e}"))?;
            if !expand_status.success() {
                return Err("UPDATE_EXTRACT_FAILED: 포터블 ZIP 압축 해제에 실패했습니다.".into());
            }

            let new_exe = std::fs::read_dir(&extract_dir)
                .map_err(|e| format!("UPDATE_EXTRACT_FAILED: 압축 해제 폴더 읽기 실패: {e}"))?
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .find(|p| {
                    p.is_file()
                        && p.extension()
                            .and_then(|e| e.to_str())
                            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                })
                .ok_or_else(|| {
                    "UPDATE_EXTRACT_FAILED: 포터블 압축 파일 내부에서 실행 파일(.exe)을 찾을 수 없습니다."
                        .to_string()
                })?;

            let swap_script = concat!(
                "$pidToWait = [int]$env:EV_WAIT_PID; ",
                "$src = $env:EV_NEW_EXE; ",
                "$dst = $env:EV_TARGET_EXE; ",
                "$tmp = $env:EV_EXTRACT_DIR; ",
                "for ($i = 0; $i -lt 30; $i++) { ",
                "  if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { break } ",
                "  Start-Sleep -Milliseconds 300 ",
                "}; ",
                "for ($i = 0; $i -lt 15; $i++) { ",
                "  try { ",
                "    Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; ",
                "    Start-Process -FilePath $dst; ",
                "    break ",
                "  } catch { Start-Sleep -Milliseconds 400 } ",
                "}; ",
                "Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue"
            );

            std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-WindowStyle",
                    "Hidden",
                    "-Command",
                    swap_script,
                ])
                .env("EV_WAIT_PID", std::process::id().to_string())
                .env("EV_NEW_EXE", &new_exe)
                .env("EV_TARGET_EXE", &current_exe)
                .env("EV_EXTRACT_DIR", &extract_dir)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("UPDATE_LAUNCH_FAILED: 포터블 교체 스크립트 실행 실패: {e}"))?;

            let app_handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                app_handle.exit(0);
            });
            return Ok(current_exe.to_string_lossy().to_string());
        }

        let spawn_res = if lower.ends_with(".msi") {
            std::process::Command::new("msiexec")
                .arg("/i")
                .arg(&dest_path)
                .spawn()
        } else {
            std::process::Command::new(&dest_path).spawn()
        };
        spawn_res.map_err(|e| format!("UPDATE_LAUNCH_FAILED: 설치 프로그램 실행 실패: {e}"))?;
        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            app_handle.exit(0);
        });
        return Ok(dest_path.to_string_lossy().to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        std::process::Command::new("open")
            .arg(&dest_path)
            .spawn()
            .map_err(|e| format!("UPDATE_LAUNCH_FAILED: DMG 열기 실패: {e}"))?;
        return Ok(dest_path.to_string_lossy().to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let _ = &app;
        let lower = safe_name.to_ascii_lowercase();
        if lower.ends_with(".appimage") {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest_path)
                .map_err(|e| format!("UPDATE_IO_FAILED: {e}"))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest_path, perms)
                .map_err(|e| format!("UPDATE_IO_FAILED: {e}"))?;
            std::process::Command::new(&dest_path)
                .spawn()
                .map_err(|e| format!("UPDATE_LAUNCH_FAILED: AppImage 실행 실패: {e}"))?;
        } else {
            std::process::Command::new("xdg-open")
                .arg(&dest_path)
                .spawn()
                .map_err(|e| format!("UPDATE_LAUNCH_FAILED: 패키지 열기 실패: {e}"))?;
        }
        return Ok(dest_path.to_string_lossy().to_string());
    }

    #[allow(unreachable_code)]
    Ok(dest_path.to_string_lossy().to_string())
}

/// Creates `path` if needed after ancestor canonicalization & deny-list checks and registers it
/// in both the Rust Zero-Trust whitelist and the Tauri fs scope for this run.
#[cfg(desktop)]
#[tauri::command]
fn allow_storage_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppSecurityState>,
    path: String,
) -> Result<(), String> {
    let canonical = validate_and_prepare_storage_dir(&path, user_home_dir().as_deref())?;
    {
        let mut dirs = state
            .approved_storage_dirs
            .lock()
            .map_err(|_| "STATE_LOCK_ERROR: 저장소 잠금 실패".to_string())?;
        dirs.insert(canonical.clone());
    }
    app.fs_scope()
        .allow_directory(&canonical, true)
        .map_err(|e| e.to_string())
}

/// Reads a validated local `.txt` or `.epub` book file as binary `tauri::ipc::Response` (desktop only).
#[cfg(desktop)]
#[tauri::command]
fn read_validated_book_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppSecurityState>,
    path: String,
    max_bytes: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let fs_scope_allowed = validate_storage_dir_path(&path).ok().is_some_and(|raw| {
        app.fs_scope().is_allowed(&raw)
            || resolve_existing_path(&raw)
                .ok()
                .is_some_and(|resolved| app.fs_scope().is_allowed(&resolved))
            || std::fs::canonicalize(&raw)
                .ok()
                .is_some_and(|canon| app.fs_scope().is_allowed(&canon))
    });

    let dirs = state
        .approved_storage_dirs
        .lock()
        .map_err(|_| "STATE_LOCK_ERROR: 저장소 잠금 실패".to_string())?
        .clone();
    let drops = state
        .approved_drop_paths
        .lock()
        .map_err(|_| "STATE_LOCK_ERROR: 드롭 경로 잠금 실패".to_string())?
        .clone();

    let bytes = validate_and_read_book_file(
        &path,
        max_bytes,
        &dirs,
        &drops,
        fs_scope_allowed,
        user_home_dir().as_deref(),
    )?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Single Zero-Trust Rust network gate for WebDAV sync & remote downloads.
#[tauri::command]
async fn safe_remote_fetch(
    request: SafeRemoteFetchRequest,
) -> Result<SafeRemoteFetchResponse, String> {
    let mut method = is_allowed_method(&request.method)?;
    let mut current_url = validate_url_syntax(&request.url)?;
    let allow_private_nas = request.allow_private_nas.unwrap_or(false);
    let allow_self_signed = request.allow_self_signed_tls.unwrap_or(false);
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1_000, 120_000));
    let max_bytes = request
        .max_response_bytes
        .unwrap_or(MAX_BOOK_BYTES)
        .min(MAX_BOOK_BYTES) as usize;

    let mut body_bytes = match request.body_base64 {
        Some(encoded) if !encoded.is_empty() => base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .map_err(|e| format!("INVALID_BODY: 요청 본문 Base64 디코딩 실패: {e}"))?,
        _ => Vec::new(),
    };
    if body_bytes.len() > MAX_REQUEST_BODY_BYTES {
        return Err("PAYLOAD_TOO_LARGE: 요청 본문이 허용 상한(1 MiB)을 초과했습니다.".into());
    }

    let mut header_map = HeaderMap::new();
    if let Some(raw_headers) = request.headers {
        for (k, v) in raw_headers {
            let lower = k.to_ascii_lowercase();
            if lower == "host" || lower == "content-length" || lower == "connection" {
                continue;
            }
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(&v),
            ) {
                header_map.insert(name, val);
            }
        }
    }

    let initial_url = current_url.clone();
    let deadline = Instant::now() + timeout;
    let pinned_map = Arc::new(Mutex::new(HashMap::<String, IpAddr>::new()));
    let resolver = Arc::new(PinnedSsrfResolver {
        pinned: Arc::clone(&pinned_map),
    });
    let client_builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .dns_resolver(resolver);

    // On Android, reqwest's default `rustls-platform-verifier` panics unless a custom
    // Kotlin/JNI verifier component is wired up. Use `webpki-roots` directly when
    // verifying standard HTTPS certificates, and `danger_accept_invalid_certs(true)`
    // when the user explicitly confirms a self-signed NAS certificate.
    #[cfg(target_os = "android")]
    let client_builder = if !allow_self_signed {
        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let mut tls_config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("HTTP_CLIENT_ERROR: {e}"))?
            .with_root_certificates(root_store)
            .with_no_client_auth();
        tls_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        client_builder.tls_backend_preconfigured(tls_config)
    } else {
        client_builder.danger_accept_invalid_certs(true)
    };

    #[cfg(not(target_os = "android"))]
    let client_builder = client_builder.danger_accept_invalid_certs(allow_self_signed);

    let client = client_builder
        .build()
        .map_err(|e| format!("HTTP_CLIENT_ERROR: {e}"))?;

    for hop in 0..=MAX_REDIRECTS {
        let remaining = compute_remaining_budget(deadline, Instant::now())?;
        let (host, pinned_addr) = resolve_and_pin_host(&current_url, allow_private_nas)?;
        if let Ok(mut guard) = pinned_map.lock() {
            guard.insert(host, pinned_addr.ip());
        }

        let mut req_builder = client
            .request(method.clone(), current_url.clone())
            .timeout(remaining);
        req_builder = req_builder.headers(header_map.clone());
        if !body_bytes.is_empty() && !matches!(method.as_str(), "GET" | "HEAD") {
            req_builder = req_builder.body(body_bytes.clone());
        }

        let mut response = req_builder.send().await.map_err(|e| {
            let msg = e.to_string();
            let lower = msg.to_ascii_lowercase();
            if e.is_timeout() || Instant::now() >= deadline {
                format!("TIMEOUT: 원격 요청 제한 시간이 초과되었습니다: {msg}")
            } else if !allow_self_signed
                && (lower.contains("certificate")
                    || lower.contains("tls")
                    || lower.contains("self-signed")
                    || lower.contains("unknown issuer"))
            {
                format!("SELF_SIGNED_TLS_CONFIRM_REQUIRED: TLS 인증서 검증에 실패했습니다: {msg}")
            } else {
                format!("REMOTE_FETCH_FAILED: 원격 요청 실패: {msg}")
            }
        })?;

        let status = response.status();
        if status.is_redirection() {
            if hop >= MAX_REDIRECTS {
                return Err("TOO_MANY_REDIRECTS: 리다이렉트 횟수(5회)를 초과했습니다.".into());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "INVALID_REDIRECT: Location 헤더가 없습니다.".to_string())?;
            let next_url = current_url
                .join(location)
                .map_err(|e| format!("INVALID_REDIRECT: 잘못된 Location URI: {e}"))?;
            validate_url_syntax(next_url.as_str())?;

            if !same_origin(&initial_url, &next_url) {
                header_map.remove(AUTHORIZATION);
                header_map.remove(COOKIE);
            }
            if status.as_u16() == 303 {
                method = reqwest::Method::GET;
                body_bytes.clear();
            }
            current_url = next_url;
            continue;
        }

        if let Some(len) = response.content_length() {
            if (len as usize) > max_bytes {
                return Err("RESPONSE_TOO_LARGE: 응답 크기가 허용 상한(256 MiB)을 초과했습니다.".into());
            }
        }

        let mut response_headers = HashMap::new();
        for (name, val) in response.headers().iter() {
            if let Ok(s) = val.to_str() {
                response_headers.insert(name.as_str().to_ascii_lowercase(), s.to_string());
            }
        }

        let mut acc = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            if e.is_timeout() || Instant::now() >= deadline {
                format!("TIMEOUT: 원격 응답 수신 시간이 초과되었습니다: {e}")
            } else {
                format!("REMOTE_STREAM_FAILED: 응답 수신 실패: {e}")
            }
        })? {
            compute_remaining_budget(deadline, Instant::now())?;
            if acc.len().saturating_add(chunk.len()) > max_bytes {
                return Err(
                    "RESPONSE_TOO_LARGE: 응답 크기가 허용 상한(256 MiB)을 초과했습니다.".into(),
                );
            }
            acc.extend_from_slice(&chunk);
        }

        return Ok(SafeRemoteFetchResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers: response_headers,
            body_base64: base64::engine::general_purpose::STANDARD.encode(&acc),
            final_url: current_url.to_string(),
        });
    }

    Err("TOO_MANY_REDIRECTS: 리다이렉트 처리에 실패했습니다.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_keyring_store::init());

    #[cfg(desktop)]
    let builder = builder
        .manage(AppSecurityState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state = window.state::<AppSecurityState>();
                let home = user_home_dir();
                if let Ok(mut drops) = state.approved_drop_paths.lock() {
                    for p in paths {
                        if let Ok(canonical) = resolve_existing_path(p) {
                            if !is_sensitive_path(&canonical, home.as_deref()) {
                                drops.insert(canonical);
                            }
                        }
                    }
                };
            }
        })
        .invoke_handler(tauri::generate_handler![
            is_desktop,
            get_platform_os,
            get_install_mode,
            allow_storage_dir,
            read_validated_book_file,
            safe_remote_fetch,
            install_release_update
        ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        is_desktop,
        get_platform_os,
        get_install_mode,
        safe_remote_fetch
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_storage_dir_paths() {
        assert!(validate_storage_dir_path("").is_err());
        assert!(validate_storage_dir_path("relative/folder").is_err());
        assert!(validate_storage_dir_path("/tmp/books/../escape").is_err());
        #[cfg(windows)]
        {
            assert!(validate_storage_dir_path(r"C:\tmp\books").is_ok());
            assert!(validate_storage_dir_path(r"\\nas\books\novel.txt").is_ok());
        }
        #[cfg(not(windows))]
        assert!(validate_storage_dir_path("/tmp/books").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_windows_verbatim_and_unc_paths() {
        assert_eq!(
            normalize_windows_verbatim(Path::new(r"\\?\UNC\nas\share\novel.txt")),
            PathBuf::from(r"\\nas\share\novel.txt")
        );
        assert_eq!(
            normalize_windows_verbatim(Path::new(r"\\?\unc\192.168.0.10\books\test.epub")),
            PathBuf::from(r"\\192.168.0.10\books\test.epub")
        );
        assert_eq!(
            normalize_windows_verbatim(Path::new(r"\\?\C:\Users\edith\Books\test.txt")),
            PathBuf::from(r"C:\Users\edith\Books\test.txt")
        );
        assert_eq!(
            normalize_windows_verbatim(Path::new(r"\\nas\share\novel.txt")),
            PathBuf::from(r"\\nas\share\novel.txt")
        );
    }

    #[test]
    fn classifies_ipv4_and_ipv6_ssrf_targets() {
        assert_eq!(
            classify_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            IpClassification::BlockedHighRisk
        );
        assert_eq!(
            classify_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))),
            IpClassification::BlockedHighRisk
        );
        assert_eq!(
            classify_ip(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0))),
            IpClassification::BlockedHighRisk
        );
        assert_eq!(
            classify_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10))),
            IpClassification::PrivateNetwork
        );
        assert_eq!(
            classify_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))),
            IpClassification::PrivateNetwork
        );
        assert_eq!(
            classify_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))),
            IpClassification::Public
        );

        assert_eq!(
            classify_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)),
            IpClassification::BlockedHighRisk
        );
        assert_eq!(
            classify_ip("::ffff:127.0.0.1".parse::<IpAddr>().unwrap()),
            IpClassification::BlockedHighRisk
        );
        assert_eq!(
            classify_ip("fc00::1".parse::<IpAddr>().unwrap()),
            IpClassification::PrivateNetwork
        );
        assert_eq!(
            classify_ip("fe80::1".parse::<IpAddr>().unwrap()),
            IpClassification::BlockedHighRisk
        );
    }

    #[test]
    fn checks_methods_and_book_extensions() {
        assert!(is_allowed_method("GET").is_ok());
        assert!(is_allowed_method("propfind").is_ok());
        assert!(is_allowed_method("TRACE").is_err());
        assert!(is_allowed_method("CONNECT").is_err());
        assert!(is_supported_book_extension(Path::new("/tmp/book.epub")));
        assert!(is_supported_book_extension(Path::new("/tmp/BOOK.TXT")));
        assert!(!is_supported_book_extension(Path::new("/tmp/payload.exe")));
    }

    #[test]
    fn matches_three_way_ssrf_equivalence_vectors() {
        let vectors = [
            ("127.0.0.1", IpClassification::BlockedHighRisk),
            ("0.0.0.0", IpClassification::BlockedHighRisk),
            ("169.254.169.254", IpClassification::BlockedHighRisk),
            ("240.0.0.1", IpClassification::BlockedHighRisk),
            ("::1", IpClassification::BlockedHighRisk),
            ("fe80::1%en0", IpClassification::BlockedHighRisk),
            ("[fe80::1%en0]", IpClassification::BlockedHighRisk),
            ("0177.0.0.1", IpClassification::BlockedHighRisk),
            ("2130706433", IpClassification::BlockedHighRisk),
            ("0x7f000001", IpClassification::BlockedHighRisk),
            ("::ffff:169.254.169.254", IpClassification::BlockedHighRisk),
            ("::ffff:192.168.1.50", IpClassification::PrivateNetwork),
            ("10.0.0.1", IpClassification::PrivateNetwork),
            ("172.16.0.1", IpClassification::PrivateNetwork),
            ("192.168.1.1", IpClassification::PrivateNetwork),
            ("100.64.0.1", IpClassification::PrivateNetwork),
            ("0300.0250.0.1", IpClassification::PrivateNetwork),
            ("fc00::1", IpClassification::PrivateNetwork),
            ("fd12:3456:789a::1", IpClassification::PrivateNetwork),
            ("8.8.8.8", IpClassification::Public),
            ("2001:4860:4860::8888", IpClassification::Public),
        ];

        for (raw, expected) in vectors {
            assert_eq!(
                classify_ip_str(raw).unwrap(),
                expected,
                "SSRF equivalence mismatch for vector {raw}"
            );
        }
    }

    #[test]
    fn enforces_zero_trust_storage_and_read_whitelist_negative_cases() {
        let sandbox_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("unit-test-zero-trust");
        let _ = std::fs::remove_dir_all(&sandbox_root);
        std::fs::create_dir_all(&sandbox_root).unwrap();

        let fake_home = sandbox_root.join("home");
        std::fs::create_dir_all(&fake_home).unwrap();

        // 1. OS & credential sensitive paths must be rejected in allow_storage_dir
        for blocked in [
            "/System/Library",
            "/Library/Preferences",
            "/etc/ssh",
            "/private/etc",
        ] {
            assert!(
                validate_and_prepare_storage_dir(blocked, Some(&fake_home)).is_err(),
                "Expected {blocked} to be rejected"
            );
        }
        for cred in [".ssh", ".gnupg", ".aws", ".kube"] {
            let p = fake_home.join(cred).join("sub");
            assert!(
                validate_and_prepare_storage_dir(p.to_str().unwrap(), Some(&fake_home)).is_err(),
                "Expected credential path {cred} to be rejected"
            );
        }

        // 2. Nonexistent leaf under safe ancestor succeeds, whereas symlink-to-/etc escape fails before create_dir_all
        let nested_safe = sandbox_root.join("books").join("nested-leaf");
        let prepared =
            validate_and_prepare_storage_dir(nested_safe.to_str().unwrap(), Some(&fake_home))
                .expect("safe nested storage folder should be prepared");
        assert!(prepared.is_dir());

        #[cfg(unix)]
        {
            let link_escape = sandbox_root.join("escape_etc");
            std::os::unix::fs::symlink("/etc", &link_escape).unwrap();
            let attempt = link_escape.join("should-not-exist");
            assert!(
                validate_and_prepare_storage_dir(attempt.to_str().unwrap(), Some(&fake_home))
                    .is_err()
            );
        }

        // 3. read_validated_book_file enforces whitelist & blocks arbitrary reads / symlink escapes
        let approved_file = prepared.join("allowed.txt");
        std::fs::write(&approved_file, b"hello allowed book").unwrap();

        let outside_dir = sandbox_root.join("outside");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let unapproved_file = outside_dir.join("secret.txt");
        std::fs::write(&unapproved_file, b"should not read").unwrap();

        let mut approved_dirs = HashSet::new();
        approved_dirs.insert(prepared.clone());
        let empty_drops = HashSet::new();

        // Allowed inside approved storage dir
        let read_ok = validate_and_read_book_file(
            approved_file.to_str().unwrap(),
            None,
            &approved_dirs,
            &empty_drops,
            false,
            Some(&fake_home),
        );
        assert_eq!(read_ok.unwrap(), b"hello allowed book");

        // Denied when outside whitelist & not dropped & not fs_scope_allowed
        let read_denied = validate_and_read_book_file(
            unapproved_file.to_str().unwrap(),
            None,
            &approved_dirs,
            &empty_drops,
            false,
            Some(&fake_home),
        );
        assert!(read_denied.unwrap_err().contains("SECURITY_DENIED"));

        // Allowed explicitly via native DragDrop set after canonicalization
        let mut drops = HashSet::new();
        drops.insert(std::fs::canonicalize(&unapproved_file).unwrap());
        assert_eq!(
            validate_and_read_book_file(
                unapproved_file.to_str().unwrap(),
                None,
                &approved_dirs,
                &drops,
                false,
                Some(&fake_home),
            )
            .unwrap(),
            b"should not read"
        );

        // Symlink inside approved dir pointing to credential file is blocked
        #[cfg(unix)]
        {
            let cred_dir = fake_home.join(".ssh");
            std::fs::create_dir_all(&cred_dir).unwrap();
            let cred_file = cred_dir.join("key.txt");
            std::fs::write(&cred_file, b"PRIVATE KEY").unwrap();
            let sneaky_link = prepared.join("harmless.txt");
            std::os::unix::fs::symlink(&cred_file, &sneaky_link).unwrap();
            let blocked_symlink = validate_and_read_book_file(
                sneaky_link.to_str().unwrap(),
                None,
                &approved_dirs,
                &empty_drops,
                false,
                Some(&fake_home),
            );
            assert!(blocked_symlink.unwrap_err().contains("SECURITY_DENIED"));
        }

        let _ = std::fs::remove_dir_all(&sandbox_root);
    }

    #[test]
    fn resolve_and_pin_host_handles_ipv6_literals_without_dns() {
        let loopback_v6 = validate_url_syntax("http://[::1]:8080/sync").unwrap();
        let err_loopback = resolve_and_pin_host(&loopback_v6, false).unwrap_err();
        assert!(
            err_loopback.contains("BLOCKED_HIGH_RISK"),
            "Expected [::1] to trigger BLOCKED_HIGH_RISK directly, got: {err_loopback}"
        );

        let mapped_meta =
            validate_url_syntax("http://[::ffff:169.254.169.254]/latest/meta-data").unwrap();
        let err_meta = resolve_and_pin_host(&mapped_meta, false).unwrap_err();
        assert!(
            err_meta.contains("BLOCKED_HIGH_RISK"),
            "Expected ::ffff:169.254.169.254 to trigger BLOCKED_HIGH_RISK, got: {err_meta}"
        );

        let ula_v6 = validate_url_syntax("https://[fc00::1]:8443/webdav").unwrap();
        let err_ula = resolve_and_pin_host(&ula_v6, false).unwrap_err();
        assert!(
            err_ula.contains("PRIVATE_NETWORK_CONFIRM_REQUIRED"),
            "Expected [fc00::1] to require confirmation, got: {err_ula}"
        );

        let (pinned_host, pinned_addr) = resolve_and_pin_host(&ula_v6, true)
            .expect("Explicit allow_private_nas should pin IPv6 ULA directly without brackets");
        assert_eq!(pinned_host, "fc00::1");
        assert_eq!(pinned_addr.port(), 8443);

        let octal_v4 = validate_url_syntax("http://0177.0.0.1:8080/").unwrap();
        assert!(resolve_and_pin_host(&octal_v4, false)
            .unwrap_err()
            .contains("BLOCKED_HIGH_RISK"));
    }

    #[test]
    fn is_sensitive_path_blocks_case_variants_when_case_insensitive() {
        let fake_home = PathBuf::from("/Users/AliceSandbox");
        assert!(is_sensitive_path_with_case_mode(
            Path::new("/system/Library"),
            Some(&fake_home),
            true
        ));
        assert!(is_sensitive_path_with_case_mode(
            Path::new("/ETC/passwd"),
            Some(&fake_home),
            true
        ));
        assert!(is_sensitive_path_with_case_mode(
            &fake_home.join(".SSH/id_ed25519"),
            Some(&fake_home),
            true
        ));
        assert!(!is_sensitive_path_with_case_mode(
            Path::new("/etcetera/Books"),
            Some(&fake_home),
            true
        ));

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            assert!(is_sensitive_path(
                Path::new("/system/Library"),
                Some(&fake_home)
            ));
            assert!(is_sensitive_path(
                &fake_home.join(".SSH/id_ed25519"),
                Some(&fake_home)
            ));
        }
    }

    #[test]
    fn compute_remaining_budget_enforces_total_deadline() {
        let now = std::time::Instant::now();
        let deadline = now + Duration::from_secs(30);
        let ok_rem = compute_remaining_budget(deadline, now + Duration::from_secs(10)).unwrap();
        assert_eq!(ok_rem, Duration::from_secs(20));

        let expired_exact = compute_remaining_budget(deadline, deadline).unwrap_err();
        assert!(expired_exact.contains("TIMEOUT:"));

        let expired_past =
            compute_remaining_budget(deadline, deadline + Duration::from_millis(5)).unwrap_err();
        assert!(expired_past.contains("TIMEOUT:"));
    }

    #[test]
    fn validates_release_update_urls_and_asset_names() {
        assert!(validate_release_download_url(
            "https://github.com/edith2580/EasyViewer/releases/download/v0.2.3/EasyViewer_0.2.3_x64-setup.exe"
        )
        .is_ok());
        assert!(validate_release_download_url("https://evil.example/EasyViewer.exe").is_err());
        assert!(validate_release_download_url("http://github.com/edith2580/EasyViewer/releases/download/v0.2.3/a.exe").is_err());

        assert!(validate_update_asset_name("EasyViewer_0.2.3_x64-setup.exe", "windows").is_ok());
        assert!(validate_update_asset_name("EasyViewer_0.2.3_x64_portable.zip", "windows").is_ok());
        assert!(validate_update_asset_name("EasyViewer_0.2.3_universal.dmg", "macos").is_ok());
        assert!(validate_update_asset_name("EasyViewer_0.2.3_amd64.AppImage", "linux").is_ok());
        assert!(validate_update_asset_name("../evil.exe", "windows").is_err());
        assert!(validate_update_asset_name("EasyViewer_0.2.3_android.apk", "windows").is_err());

        #[cfg(target_os = "windows")]
        assert_eq!(
            normalize_win_dir_key(Path::new(r"\\?\D:\Custom\EasyViewer\")),
            r"d:\custom\easyviewer"
        );
        assert_eq!(
            detect_windows_install_mode(Path::new(r"D:\Portable\EasyViewer\EasyViewer.exe")),
            "portable"
        );
        // Without a matching MSI registry entry, Program Files alone must not be assumed MSI
        assert_eq!(
            detect_windows_install_mode(Path::new(r"C:\Program Files\NonExistentEasyViewer\EasyViewer.exe")),
            "portable"
        );
    }
}
