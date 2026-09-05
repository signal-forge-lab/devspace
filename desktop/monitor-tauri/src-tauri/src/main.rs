#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env, fs,
    net::{IpAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    time::Duration,
};

use tauri::{
    webview::{NewWindowResponse, Url, WebviewWindowBuilder},
    State, WebviewUrl,
};

mod monitor_host;
use monitor_host::{
    host_init_script, monitor_status, run_monitor_action, save_startup_config,
    start_memory_sampler, MonitorState,
};

const DEFAULT_MONITOR_URL: &str = "http://127.0.0.1:7677/monitor";

fn main() {
    let project_root = resolve_workbridge_project_root(
        env::var_os("WORKBRIDGE_PROJECT_ROOT").map(PathBuf::from),
        root_candidates(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let monitor_url = resolve_monitor_url(env::var("WORKBRIDGE_MONITOR_URL").ok().as_deref())
        .unwrap_or_else(|error| panic!("{error}"));
    let init_script = host_init_script(&project_root, monitor_url.as_str());
    let allowed_url = monitor_url.clone();
    let initial_url = startup_webview_url(&monitor_url, monitor_endpoint_reachable(&monitor_url));
    let monitor_state = MonitorState::new(project_root.clone(), monitor_url.to_string());

    tauri::Builder::default()
        .manage(monitor_state)
        .invoke_handler(tauri::generate_handler![
            monitor_status,
            monitor_reachable,
            run_monitor_action,
            save_startup_config
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", initial_url.clone())
                .title("Workbridge Monitor")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .initialization_script(init_script.clone())
                .on_navigation(move |url| allowed_webview_navigation(url, &allowed_url))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            start_memory_sampler(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Workbridge Monitor");
}

fn root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current) = env::current_dir() {
        candidates.push(current);
    }
    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    candidates
}

fn resolve_workbridge_project_root(
    explicit: Option<PathBuf>,
    candidates: Vec<PathBuf>,
) -> Result<PathBuf, String> {
    explicit
        .into_iter()
        .chain(candidates)
        .find_map(|candidate| {
            candidate
                .ancestors()
                .take(8)
                .find(|path| is_workbridge_root(path))
                .map(Path::to_path_buf)
        })
        .ok_or_else(|| {
            "Unable to locate the Workbridge project root. Set WORKBRIDGE_PROJECT_ROOT.".to_string()
        })
}

fn is_workbridge_root(candidate: &Path) -> bool {
    let Ok(package_json) = fs::read_to_string(candidate.join("package.json")) else {
        return false;
    };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&package_json) else {
        return false;
    };
    package.get("name").and_then(|value| value.as_str()) == Some("@waishnav/devspace")
        && candidate.join("src").is_dir()
}

fn resolve_monitor_url(value: Option<&str>) -> Result<Url, String> {
    let candidate = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MONITOR_URL);
    let mut url = Url::parse(candidate).map_err(|_| "Workbridge monitor URL is invalid.")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Workbridge monitor URL must use http or https.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Workbridge monitor URL must not include credentials.".to_string());
    }
    if !is_loopback_host(url.host_str()) {
        return Err("Workbridge monitor URL must use a loopback hostname.".to_string());
    }
    match url.path() {
        "" | "/" => url.set_path("/monitor"),
        "/monitor" | "/monitor/" => url.set_path("/monitor"),
        _ => return Err("Workbridge monitor URL path must be /monitor.".to_string()),
    }
    url.set_fragment(None);
    Ok(url)
}

fn is_loopback_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

fn monitor_endpoint_reachable(url: &Url) -> bool {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return false;
    };
    (host, port)
        .to_socket_addrs()
        .ok()
        .into_iter()
        .flatten()
        .filter(|address| address.ip().is_loopback())
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok())
}

#[tauri::command]
fn monitor_reachable(state: State<'_, MonitorState>) -> bool {
    Url::parse(state.monitor_url())
        .ok()
        .is_some_and(|url| monitor_endpoint_reachable(&url))
}

fn startup_webview_url(monitor_url: &Url, monitor_reachable: bool) -> WebviewUrl {
    if monitor_reachable {
        WebviewUrl::External(monitor_url.clone())
    } else {
        WebviewUrl::App("index.html".into())
    }
}

fn allowed_monitor_navigation(candidate: &Url, expected: &Url) -> bool {
    candidate.scheme() == expected.scheme()
        && candidate.host_str() == expected.host_str()
        && candidate.port_or_known_default() == expected.port_or_known_default()
        && candidate.username().is_empty()
        && candidate.password().is_none()
        && matches!(candidate.path(), "/monitor" | "/monitor/")
}

fn allowed_bootstrap_navigation(candidate: &Url) -> bool {
    let local_origin = (matches!(candidate.scheme(), "http" | "https")
        && candidate.host_str() == Some("tauri.localhost"))
        || (candidate.scheme() == "tauri" && candidate.host_str() == Some("localhost"));
    local_origin
        && candidate.username().is_empty()
        && candidate.password().is_none()
        && matches!(candidate.path(), "/" | "/index.html")
        && candidate.query().is_none()
        && candidate.fragment().is_none()
}

fn allowed_webview_navigation(candidate: &Url, expected: &Url) -> bool {
    allowed_monitor_navigation(candidate, expected) || allowed_bootstrap_navigation(candidate)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        env::temp_dir().join(format!("workbridge-tauri-{unique}"))
    }
    #[test]
    fn monitor_url_is_loopback_and_bounded() {
        let default = resolve_monitor_url(None).expect("default monitor URL");
        assert_eq!(default.as_str(), DEFAULT_MONITOR_URL);
        assert!(resolve_monitor_url(Some("https://example.com/monitor")).is_err());
        assert!(resolve_monitor_url(Some("http://127.0.0.1:7677/other")).is_err());
        assert!(resolve_monitor_url(Some("http://user:pass@127.0.0.1:7677/monitor")).is_err());
        let localhost = resolve_monitor_url(Some("http://localhost:7677/monitor/"))
            .expect("localhost monitor URL");
        assert_eq!(localhost.path(), "/monitor");
    }

    #[test]
    fn root_discovery_matches_workbridge_shape() {
        let root = test_root();
        let nested = root.join("desktop").join("monitor-tauri");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::create_dir_all(&nested).expect("nested");
        fs::write(
            root.join("package.json"),
            r#"{"name":"@waishnav/devspace"}"#,
        )
        .expect("package.json");
        let resolved =
            resolve_workbridge_project_root(None, vec![nested]).expect("resolve project root");
        assert_eq!(resolved, root);
        fs::remove_dir_all(resolved).expect("cleanup");
    }

    #[test]
    fn navigation_stays_on_monitor_origin() {
        let expected = resolve_monitor_url(None).expect("monitor URL");
        let same = Url::parse("http://127.0.0.1:7677/monitor/").expect("same URL");
        let other_path = Url::parse("http://127.0.0.1:7677/other").expect("other path");
        let other_port = Url::parse("http://127.0.0.1:7678/monitor").expect("other port");
        assert!(allowed_monitor_navigation(&same, &expected));
        assert!(!allowed_monitor_navigation(&other_path, &expected));
        assert!(!allowed_monitor_navigation(&other_port, &expected));
    }

    #[test]
    fn startup_uses_local_bootstrap_when_monitor_is_unreachable() {
        let expected = resolve_monitor_url(None).expect("monitor URL");
        assert!(matches!(
            startup_webview_url(&expected, false),
            WebviewUrl::App(path) if path == PathBuf::from("index.html")
        ));
        assert!(matches!(
            startup_webview_url(&expected, true),
            WebviewUrl::External(url) if url == expected
        ));
    }

    #[test]
    fn monitor_reachability_tracks_loopback_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let address = listener.local_addr().expect("address");
        let url = Url::parse(&format!("http://127.0.0.1:{}/monitor", address.port()))
            .expect("monitor URL");
        assert!(monitor_endpoint_reachable(&url));
        drop(listener);
        assert!(!monitor_endpoint_reachable(&url));
    }

    #[test]
    fn bootstrap_navigation_is_local_and_bounded() {
        let monitor = resolve_monitor_url(None).expect("monitor URL");
        let bootstrap = Url::parse("http://tauri.localhost/index.html").expect("bootstrap URL");
        let bootstrap_root = Url::parse("http://tauri.localhost/").expect("bootstrap root");
        let local_other = Url::parse("http://tauri.localhost/other").expect("other local URL");
        let remote_other = Url::parse("https://example.com/").expect("remote URL");
        assert!(allowed_webview_navigation(&bootstrap, &monitor));
        assert!(allowed_webview_navigation(&bootstrap_root, &monitor));
        assert!(!allowed_webview_navigation(&local_other, &monitor));
        assert!(!allowed_webview_navigation(&remote_other, &monitor));
    }
}
