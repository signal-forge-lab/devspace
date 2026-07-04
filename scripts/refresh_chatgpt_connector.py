#!/usr/bin/env python3
"""Refresh the DevSpace ChatGPT connector app and wait for its version note to advance."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

try:  # optional; useful for ChatGPT, not required for local dry runs
    from playwright_stealth import Stealth as _PWStealth
except Exception:  # pragma: no cover - optional dependency
    _PWStealth = None


APP_NAME = "refresh_chatgpt_connector"
APP_VERSION = "0.1.0"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_LOCAL = Path(__file__).with_name("chatgpt_connector_refresh.config.local.json")
DEFAULT_CONFIG_EXAMPLE = Path(__file__).with_name("chatgpt_connector_refresh.config.example.json")
DEFAULT_METADATA_OUT = PROJECT_ROOT / ".devspace" / "connector_refresh" / "last_run.json"
CHATGPT_HOSTS = {"chatgpt.com", "www.chatgpt.com", "chat.openai.com"}
VERSION_RE = re.compile(r"(?<![A-Za-z0-9])v?(\d+(?:\.\d+){1,3})(?![A-Za-z0-9])", re.IGNORECASE)


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"config file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid JSON config: {path}: {exc}") from exc


def load_config(path: Path | None) -> tuple[dict[str, Any], Path]:
    config_path = path
    if config_path is None:
        config_path = DEFAULT_CONFIG_LOCAL if DEFAULT_CONFIG_LOCAL.is_file() else DEFAULT_CONFIG_EXAMPLE
    config_path = config_path.expanduser().resolve()
    return load_json(config_path), config_path


def write_metadata(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_project_path(value: str | None, fallback: Path | None = None) -> Path | None:
    raw = str(value or "").strip()
    if not raw:
        return fallback
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()


def validate_chatgpt_settings_url(value: str) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in CHATGPT_HOSTS:
        raise ValueError("target_url must be an HTTPS ChatGPT URL")
    fragment = parsed.fragment.lower()
    if "settings" not in fragment:
        raise ValueError("target_url must include the ChatGPT settings fragment")
    if "connector=" not in fragment:
        raise ValueError("target_url must include connector=<app id> in the fragment")
    return url


def apply_stealth(context: Any) -> None:
    if _PWStealth is not None:
        try:
            _PWStealth().apply_stealth_sync(context)
        except Exception:
            pass


def cdp_endpoint_available(endpoint: str | None) -> bool:
    if not endpoint:
        return False
    try:
        with urllib.request.urlopen(endpoint.rstrip("/") + "/json/version", timeout=1.0) as response:
            return 200 <= int(getattr(response, "status", 0)) < 300
    except Exception:
        return False


def cdp_port_from_endpoint(endpoint: str | None) -> int | None:
    if not endpoint:
        return None
    try:
        return urlparse(endpoint).port
    except Exception:
        return None


def connect_or_launch_context(playwright: Any, config: dict[str, Any], *, headless_override: bool = False):
    browser_cfg = config.get("browser") or {}
    cdp_endpoint = str(browser_cfg.get("cdp_endpoint") or "").strip() or None
    open_mode = str(browser_cfg.get("open_mode") or "foreground").strip().lower()
    if open_mode not in {"foreground", "minimized", "background", "headless"}:
        raise RuntimeError("browser.open_mode must be foreground, minimized, background, or headless")

    headless = bool(headless_override or open_mode == "headless")
    start_minimized = bool(browser_cfg.get("start_minimized", False) or open_mode == "minimized")
    keep_open = bool(browser_cfg.get("keep_browser_open_after_exit", True))
    profile_dir = resolve_project_path(browser_cfg.get("profile_dir") or config.get("profile_dir"))
    launch_args: list[str] = []
    if start_minimized:
        launch_args.append("--start-minimized")

    if cdp_endpoint and not headless and cdp_endpoint_available(cdp_endpoint):
        browser = playwright.chromium.connect_over_cdp(cdp_endpoint)
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        apply_stealth(context)
        return context, browser, "cdp_connected", False

    if profile_dir is not None:
        kwargs: dict[str, Any] = {"user_data_dir": str(profile_dir), "headless": headless}
        port = cdp_port_from_endpoint(cdp_endpoint) if keep_open and not headless else None
        if port is not None:
            launch_args.append(f"--remote-debugging-port={port}")
        if launch_args:
            kwargs["args"] = launch_args
        context = playwright.chromium.launch_persistent_context(**kwargs)
        apply_stealth(context)
        return context, None, "persistent_context_launched", not keep_open

    browser_kwargs: dict[str, Any] = {"headless": headless}
    if launch_args:
        browser_kwargs["args"] = launch_args
    browser = playwright.chromium.launch(**browser_kwargs)
    context = browser.new_context()
    apply_stealth(context)
    return context, browser, "ephemeral_browser_launched", not keep_open


def safe_page_url(page: Any) -> str:
    try:
        return str(page.url or "")
    except Exception:
        return ""


def live_pages(context: Any) -> list[Any]:
    pages: list[Any] = []
    for page in list(context.pages):
        try:
            if not page.is_closed():
                pages.append(page)
        except Exception:
            continue
    return pages


def is_blank_url(url: str) -> bool:
    normalized = (url or "").strip().lower()
    return normalized in {"", "about:blank"} or normalized.startswith("chrome://new-tab-page")


def select_or_open_settings_page(context: Any, target_url: str, *, bring_to_front: bool = True):
    normalized_target = target_url.rstrip("/")
    pages = live_pages(context)

    for page in pages:
        page_url = safe_page_url(page).rstrip("/")
        if page_url == normalized_target:
            if bring_to_front:
                page.bring_to_front()
            return page, "existing_target_tab"

    for page in pages:
        page_url = safe_page_url(page)
        if is_blank_url(page_url):
            continue
        host = (urlparse(page_url).hostname or "").lower()
        if host in CHATGPT_HOSTS:
            if bring_to_front:
                page.bring_to_front()
            return page, "existing_chatgpt_tab_reused"

    page = context.new_page()
    if bring_to_front:
        page.bring_to_front()
    return page, "new_self_owned_tab"


def wait_for_settings_page(page: Any, target_url: str, timeout_ms: int) -> None:
    page.goto(target_url, wait_until="domcontentloaded", timeout=timeout_ms)
    page.locator("body").wait_for(state="visible", timeout=timeout_ms)
    page.wait_for_timeout(1500)


def version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def expected_next_version(version: str) -> str:
    parts = [int(part) for part in version.split(".")]
    if not parts:
        raise ValueError(f"invalid version: {version}")
    parts[-1] += 1
    return ".".join(str(part) for part in parts)


def version_at_least(current: str, expected: str) -> bool:
    current_parts = list(version_tuple(current))
    expected_parts = list(version_tuple(expected))
    width = max(len(current_parts), len(expected_parts))
    current_parts.extend([0] * (width - len(current_parts)))
    expected_parts.extend([0] * (width - len(expected_parts)))
    return tuple(current_parts) >= tuple(expected_parts)


def extract_versions(text: str) -> list[str]:
    return [match.group(1) for match in VERSION_RE.finditer(text or "")]


def extract_version_from_page(page: Any, labels: list[str]) -> tuple[str | None, str]:
    label_lowers = [label.lower() for label in labels if label]
    payload = page.evaluate(
        """
        () => {
          const bodyText = document.body?.innerText || "";
          const controls = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"]'));
          const fieldData = controls.slice(0, 100).map((el) => {
            const value = el.value || el.innerText || el.textContent || "";
            const parts = [
              el.getAttribute('aria-label') || "",
              el.getAttribute('placeholder') || "",
            ];
            let cur = el;
            for (let i = 0; i < 4 && cur; i += 1) {
              parts.push((cur.innerText || cur.textContent || "").slice(0, 2000));
              cur = cur.parentElement;
            }
            return { value, context: parts.filter(Boolean).join("\n") };
          });
          return { bodyText, fieldData };
        }
        """
    )

    for field in payload.get("fieldData", []):
        field_context = str(field.get("context") or "")
        field_value = str(field.get("value") or "")
        combined = (field_context + "\n" + field_value).lower()
        if any(label in combined for label in label_lowers):
            versions = extract_versions(field_value) or extract_versions(field_context)
            if versions:
                return versions[-1], "field_near_version_note_label"

    body_text = str(payload.get("bodyText") or "")
    body_lower = body_text.lower()
    for label in label_lowers:
        index = body_lower.find(label)
        if index >= 0:
            section = body_text[index : index + 2500]
            versions = extract_versions(section)
            if versions:
                return versions[-1], "body_section_near_version_note_label"

    return None, "not_found"


def click_first_visible_enabled(locator: Any, timeout_ms: int) -> str | None:
    try:
        count = min(locator.count(), 20)
    except Exception:
        return None
    for index in range(count):
        candidate = locator.nth(index)
        try:
            if candidate.is_visible(timeout=500) and candidate.is_enabled(timeout=500):
                candidate.click(timeout=timeout_ms)
                return f"locator_index_{index}"
        except Exception:
            continue
    return None


def click_update_button(page: Any, names: list[str], timeout_ms: int) -> str:
    patterns = [re.compile(rf"^\s*{re.escape(name)}\s*$", re.IGNORECASE) for name in names if name]
    patterns.append(re.compile(r"更新|Update|Refresh", re.IGNORECASE))

    for pattern in patterns:
        clicked = click_first_visible_enabled(page.get_by_role("button", name=pattern), timeout_ms)
        if clicked:
            return f"role_button:{pattern.pattern}:{clicked}"

    for name in names:
        escaped = name.replace("'", "\\'")
        selector = f"button:has-text('{escaped}')"
        clicked = click_first_visible_enabled(page.locator(selector), timeout_ms)
        if clicked:
            return f"css_button_text:{name}:{clicked}"

    raise PlaywrightTimeoutError(f"Update button not found or not enabled. Tried names: {names}")


def wait_for_version_increment(
    page: Any,
    labels: list[str],
    initial: str,
    expected: str,
    timeout_seconds: int,
    interval_seconds: float,
) -> tuple[str, str]:
    deadline = time.monotonic() + timeout_seconds
    last_version = initial
    last_source = "initial"
    while time.monotonic() < deadline:
        page.wait_for_timeout(int(max(interval_seconds, 0.5) * 1000))
        current, source = extract_version_from_page(page, labels)
        if current:
            last_version = current
            last_source = source
            if version_at_least(current, expected):
                return current, source
    raise TimeoutError(
        f"version did not reach expected value before timeout: initial={initial}, expected={expected}, last={last_version}, source={last_source}"
    )


def discord_config(config: dict[str, Any]) -> dict[str, Any]:
    notifications = config.get("notifications") or {}
    return notifications.get("discord") or {}


def send_discord_notification(config: dict[str, Any], content: str) -> None:
    discord = discord_config(config)
    if not bool(discord.get("enabled", False)):
        return
    env_key = str(discord.get("webhook_url_env_key") or "").strip()
    if not env_key:
        raise RuntimeError("notifications.discord.webhook_url_env_key is required when Discord notifications are enabled")
    hook_url = os.environ.get(env_key, "").strip()
    if not hook_url:
        raise RuntimeError(f"Discord webhook URL environment variable is not set: {env_key}")
    timeout_seconds = int(discord.get("timeout_seconds") or 10)
    body = json.dumps({"content": content}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        hook_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": f"{APP_NAME}/{APP_VERSION}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        status = int(getattr(response, "status", 0))
        if status < 200 or status >= 300:
            raise RuntimeError(f"Discord notification failed: HTTP {status}")


def success_message(metadata: dict[str, Any]) -> str:
    return "\n".join(
        [
            "DevSpace Connector refresh completed.",
            f"status: {metadata.get('status')}",
            f"version: {metadata.get('initial_version')} -> {metadata.get('final_version')}",
            f"expected: {metadata.get('expected_version')}",
            f"elapsed_seconds: {metadata.get('elapsed_seconds')}",
        ]
    )


def failure_message(metadata: dict[str, Any]) -> str:
    return "\n".join(
        [
            "DevSpace Connector refresh failed.",
            f"status: {metadata.get('status')}",
            f"error: {metadata.get('error_class')}: {metadata.get('error')}",
            f"initial_version: {metadata.get('initial_version')}",
            f"last_page_url: {metadata.get('page_url')}",
        ]
    )


def run(config: dict[str, Any], metadata_out: Path, *, headless: bool = False, no_notify: bool = False) -> dict[str, Any]:
    target_url = validate_chatgpt_settings_url(str(config.get("target_url") or ""))
    poll_cfg = config.get("poll") or {}
    selectors_cfg = config.get("selectors") or {}
    timeout_ms = int(poll_cfg.get("page_load_timeout_ms") or 60_000)
    wait_timeout_seconds = int(poll_cfg.get("version_wait_timeout_seconds") or 300)
    interval_seconds = float(poll_cfg.get("interval_seconds") or 2.0)
    update_button_names = [str(item) for item in selectors_cfg.get("update_button_names") or ["更新", "Update", "Refresh"]]
    version_note_labels = [str(item) for item in selectors_cfg.get("version_note_labels") or ["バージョンに関する注記", "Version notes", "Version note"]]
    browser_cfg = config.get("browser") or {}
    open_mode = str(browser_cfg.get("open_mode") or "foreground")
    bring_to_front = bool(browser_cfg.get("bring_to_front", True)) and open_mode == "foreground" and not headless

    started_monotonic = time.monotonic()
    metadata: dict[str, Any] = {
        "app": APP_NAME,
        "version": APP_VERSION,
        "status": "started",
        "target_url": target_url,
        "metadata_out": str(metadata_out),
        "started_at": now_iso(),
        "external_actions": ["open_chatgpt_settings", "click_update_button", "wait_for_version_increment"],
    }
    write_metadata(metadata_out, metadata)

    with sync_playwright() as playwright:
        context = None
        browser = None
        close_context = False
        page = None
        try:
            context, browser, browser_mode, close_context = connect_or_launch_context(playwright, config, headless_override=headless)
            page, page_mode = select_or_open_settings_page(context, target_url, bring_to_front=bring_to_front)
            metadata.update({"browser_mode": browser_mode, "page_mode": page_mode})
            wait_for_settings_page(page, target_url, timeout_ms)
            initial_version, initial_source = extract_version_from_page(page, version_note_labels)
            if not initial_version:
                raise RuntimeError("Could not find an initial version near the version note label")
            expected_version = expected_next_version(initial_version)
            metadata.update({
                "initial_version": initial_version,
                "initial_version_source": initial_source,
                "expected_version": expected_version,
                "before_click_at": now_iso(),
            })
            write_metadata(metadata_out, metadata)

            click_source = click_update_button(page, update_button_names, timeout_ms)
            metadata.update({"update_click_source": click_source, "clicked_at": now_iso()})
            write_metadata(metadata_out, metadata)

            final_version, final_source = wait_for_version_increment(
                page,
                version_note_labels,
                initial_version,
                expected_version,
                wait_timeout_seconds,
                interval_seconds,
            )
            metadata.update({
                "status": "success",
                "final_version": final_version,
                "final_version_source": final_source,
                "completed_at": now_iso(),
                "elapsed_seconds": round(time.monotonic() - started_monotonic, 1),
                "page_url": safe_page_url(page),
            })
            write_metadata(metadata_out, metadata)
            if not no_notify:
                send_discord_notification(config, success_message(metadata))
            return metadata
        except Exception as exc:
            metadata.update({
                "status": "error",
                "error_class": exc.__class__.__name__,
                "error": str(exc),
                "completed_at": now_iso(),
                "elapsed_seconds": round(time.monotonic() - started_monotonic, 1),
                "page_url": safe_page_url(page) if page is not None else "not_available",
            })
            write_metadata(metadata_out, metadata)
            if not no_notify and bool(discord_config(config).get("notify_on_failure", True)):
                try:
                    send_discord_notification(config, failure_message(metadata))
                except Exception as notify_exc:
                    metadata["discord_failure_notification_error"] = str(notify_exc)
                    write_metadata(metadata_out, metadata)
            raise
        finally:
            if close_context and context is not None:
                context.close()
            elif close_context and browser is not None:
                browser.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh the DevSpace ChatGPT connector app and wait for the version note to advance.")
    parser.add_argument("--config", help="Path to JSON config. Defaults to local config, then example config.")
    parser.add_argument("--metadata-out", help="Path to write run metadata JSON.")
    parser.add_argument("--headless", action="store_true", help="Run Chromium headless. Usually not useful for an already logged-in ChatGPT profile.")
    parser.add_argument("--no-notify", action="store_true", help="Do not send Discord notifications for this run.")
    args = parser.parse_args(argv)

    config_path = Path(args.config).expanduser() if args.config else None
    config, resolved_config_path = load_config(config_path)
    metadata_out = resolve_project_path(args.metadata_out, DEFAULT_METADATA_OUT) if args.metadata_out else DEFAULT_METADATA_OUT
    assert metadata_out is not None
    metadata = run(config, metadata_out, headless=bool(args.headless), no_notify=bool(args.no_notify))
    metadata["config_path"] = str(resolved_config_path)
    write_metadata(metadata_out, metadata)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        raise SystemExit(130)
