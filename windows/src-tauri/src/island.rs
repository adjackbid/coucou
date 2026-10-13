// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn inside a
// borderless, transparent, always-on-top window that never takes focus. The
// window sits against the edge the person docked the island to (settings.rs,
// `Dock`): the top (left, centre or right) or the left or right side.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::settings::{Dock, Settings};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

/// Logical size of the full window — the largest island view. Wider than the
/// macOS panel: the overview grows a card per unread session, up to three
/// (640 + 2 × 280, plus a margin). Everything outside the island shape is
/// transparent and click-through, so the width costs nothing.
pub const PANEL_W: f64 = 1320.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible strip that wakes the island when it is hidden:
/// its length along the edge and its thickness.
pub const STRIP_LEN: f64 = 240.0;
pub const STRIP_THICK: f64 = 6.0;

/// The compact capsule (layout.ts COMPACT_W x NOTCH_H), on its side when docked
/// to the left or right.
pub const CAPSULE_LEN: f64 = 288.0;
pub const CAPSULE_THICK: f64 = 32.0;
/// Gap between the capsule and the screen corner when docked top left / top right.
pub const TOP_INSET: f64 = 24.0;
/// Room kept above and below a capsule on its side.
pub const SIDE_MARGIN: f64 = 12.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    /// The dock the island is drawn for — the saved one, unless this display
    /// is too short for a capsule on its side (then top centre).
    pub dock: Dock,
    /// Where the capsule's centre wants to be in the full window, logical px
    /// from its top. The window is clamped to the work area, so the front end
    /// cannot work this out from the offset alone.
    pub anchor_in_window: f64,
}

/// What `dock-changed` tells the front end after the window moved.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockPlacement {
    pub dock: Dock,
    pub anchor_in_window: f64,
}

/// A rectangle in physical pixels (a monitor's work area, a window).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Area {
    fn of(m: &Monitor) -> Self {
        let wa = m.work_area();
        Area { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height }
    }
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into Win32 when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

// Files are dropped through WebView2's own HTML5 drag and drop (see
// `dragDropEnabled: false` in tauri.conf.json and `wireInput` in island.ts).
// wry's OLE drop target never gets a chance here: WebView2 keeps its
// `Chrome_WidgetWin_1` in the msedgewebview2 process, OLE finds that window
// first, and its target refuses whatever wry registered on ours. The page
// handling the drop itself needs no window hack at all.

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// Which display the island lives on, by index into `names`: the one it was
/// dropped on while `screen` is "docked" and that display is still there, the
/// one under the cursor for "cursor", else the primary, else the first.
/// An unplugged display is not forgotten — plugged back in, it wins again.
pub fn pick_monitor(
    names: &[String],
    primary: Option<usize>,
    under_cursor: Option<usize>,
    screen: &str,
    docked: &str,
) -> Option<usize> {
    if screen == "docked" && !docked.is_empty() {
        if let Some(i) = names.iter().position(|n| n == docked) {
            return Some(i);
        }
    }
    if screen == "cursor" {
        if let Some(i) = under_cursor {
            return Some(i);
        }
    }
    primary.or(if names.is_empty() { None } else { Some(0) })
}

pub fn monitor_name(m: &Monitor) -> String {
    m.name().cloned().unwrap_or_default()
}

/// The display the island lives on (see `pick_monitor`).
pub fn resolve_monitor(app: &AppHandle, settings: &Settings) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    let names: Vec<String> = monitors.iter().map(monitor_name).collect();
    let primary = app.primary_monitor().ok().flatten().and_then(|p| {
        monitors
            .iter()
            .position(|m| m.position() == p.position() && m.size() == p.size())
    });
    let under_cursor = cursor_physical()
        .and_then(|(cx, cy)| monitors.iter().position(|m| monitor_contains(m, cx, cy)));
    let i = pick_monitor(&names, primary, under_cursor, &settings.screen, &settings.dock.monitor)?;
    monitors.into_iter().nth(i)
}

/// The dock as it can be drawn on this work area: a capsule on its side needs
/// its whole length plus a margin above and below, or it goes top centre for
/// now (the saved dock is left alone).
pub fn effective_dock(dock: &Dock, wa: Area, scale: f64) -> Dock {
    if dock.is_vertical() && (wa.h as f64 / scale) < CAPSULE_LEN + 2.0 * SIDE_MARGIN {
        return Dock { edge: "top".into(), anchor: "center".into(), ..dock.clone() };
    }
    dock.clone()
}

fn px(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

/// Top-left corner of the full panel window, physical px.
fn panel_origin(dock: &Dock, wa: Area, scale: f64) -> (i32, i32) {
    let pw = px(PANEL_W, scale);
    let ph = px(PANEL_H, scale);
    let (waw, wah) = (wa.w as i32, wa.h as i32);
    match dock.edge.as_str() {
        "left" | "right" => {
            let x = if dock.edge == "left" { wa.x } else { wa.x + waw - pw };
            let want = wa.y as f64 + dock.offset * wah as f64 - ph as f64 / 2.0;
            let lo = wa.y;
            let hi = (wa.y + wah - ph).max(lo);
            (x, (want.round() as i32).clamp(lo, hi))
        }
        _ => {
            let x = match dock.anchor.as_str() {
                "start" => wa.x,
                "end" => wa.x + waw - pw,
                _ => wa.x + (waw - pw) / 2,
            };
            (x, wa.y)
        }
    }
}

/// Where the capsule's centre wants to be in the panel window, logical px
/// from its top (side docks; top docks get the capsule's own centre).
pub fn anchor_in_window(dock: &Dock, wa: Area, scale: f64) -> f64 {
    if !dock.is_vertical() {
        return CAPSULE_THICK / 2.0;
    }
    let (_, y) = panel_origin(dock, wa, scale);
    let want = wa.y as f64 + dock.offset * wa.h as f64;
    (want - y as f64) / scale
}

/// The compact capsule inside the panel window, logical px — the same numbers
/// as `dockedRect` in src/core/dock.ts.
pub fn capsule_in_window(dock: &Dock, anchor: f64) -> (f64, f64, f64, f64) {
    match dock.edge.as_str() {
        "left" | "right" => {
            let y = (anchor - CAPSULE_LEN / 2.0).clamp(0.0, PANEL_H - CAPSULE_LEN);
            let x = if dock.edge == "left" { 0.0 } else { PANEL_W - CAPSULE_THICK };
            (x, y, CAPSULE_THICK, CAPSULE_LEN)
        }
        _ => {
            let x = match dock.anchor.as_str() {
                "start" => TOP_INSET,
                "end" => PANEL_W - CAPSULE_LEN - TOP_INSET,
                _ => (PANEL_W - CAPSULE_LEN) / 2.0,
            };
            (x, 0.0, CAPSULE_LEN, CAPSULE_THICK)
        }
    }
}

/// The window for a dock, physical px: the full panel, or the wake strip
/// (`collapsed`) lying along the edge, centred on where the capsule comes out.
pub fn window_rect(dock: &Dock, wa: Area, scale: f64, collapsed: bool) -> (i32, i32, u32, u32) {
    let (ox, oy) = panel_origin(dock, wa, scale);
    if !collapsed {
        return (ox, oy, px(PANEL_W, scale).max(1) as u32, px(PANEL_H, scale).max(1) as u32);
    }
    let len = px(STRIP_LEN, scale).max(1);
    let thick = px(STRIP_THICK, scale).max(1);
    let (cx, cy, cw, ch) = capsule_in_window(dock, anchor_in_window(dock, wa, scale));
    let mid_x = ox + px(cx + cw / 2.0, scale);
    let mid_y = oy + px(cy + ch / 2.0, scale);
    match dock.edge.as_str() {
        "left" => (wa.x, mid_y - len / 2, thick as u32, len as u32),
        "right" => (wa.x + wa.w as i32 - thick, mid_y - len / 2, thick as u32, len as u32),
        _ => (mid_x - len / 2, wa.y, len as u32, thick as u32),
    }
}

/// The stand-in the island always used when no display could be read.
fn fallback_area() -> Area {
    Area { x: 0, y: 0, w: 1920, h: 1080 }
}

pub fn screen_info(app: &AppHandle, settings: &Settings) -> ScreenInfo {
    let monitor = resolve_monitor(app, settings);
    let (wa, scale) = monitor
        .as_ref()
        .map(|m| (Area::of(m), m.scale_factor()))
        .unwrap_or((fallback_area(), 1.0));
    let dock = effective_dock(&settings.dock, wa, scale);
    let anchor_in_window = anchor_in_window(&dock, wa, scale);
    let (x, y, width, height) = match &monitor {
        Some(m) => {
            let p = m.position();
            let s = m.size();
            (p.x as f64 / scale, p.y as f64 / scale, s.width as f64 / scale, s.height as f64 / scale)
        }
        None => (0.0, 0.0, 1920.0, 1080.0),
    };
    ScreenInfo { x, y, width, height, scale, dock, anchor_in_window }
}

/// Places and sizes the window for the settings' dock. `collapsed` picks the
/// wake strip instead of the panel. Tells the front end where the capsule goes.
pub fn apply_geometry(app: &AppHandle, settings: &Settings, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = resolve_monitor(app, settings) else { return };
    let scale = m.scale_factor();
    let wa = Area::of(&m);
    let dock = effective_dock(&settings.dock, wa, scale);
    let (x, y, w, h) = window_rect(&dock, wa, scale, collapsed);

    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_always_on_top(true);

    let anchor_in_window = anchor_in_window(&dock, wa, scale);
    let _ = app.emit_to(WINDOW_LABEL, "dock-changed", DockPlacement { dock, anchor_in_window });
}

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// The display the island lives on — which one, where, its work area and
/// scale. Any change here (a display unplugged, the taskbar moved, a new
/// scale) means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<String> {
    let settings = app.try_state::<crate::Shared>()?.settings.lock().unwrap().clone();
    let m = resolve_monitor(app, &settings)?;
    let p = m.position();
    let size = m.size();
    Some(format!(
        "{}|{},{}|{}x{}|{:?}|{}",
        monitor_name(&m),
        p.x,
        p.y,
        size.width,
        size.height,
        Area::of(&m),
        m.scale_factor().to_bits()
    ))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<String> = None;
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(16));

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % 30 == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                //
                // Read before the "cursor has not moved" shortcut below: a click is
                // a press, not a move, and must never be skipped for standing still.
                let down = left_button_down();
                if down && !was_down && !on_island {
                    // A press anywhere but on the island shuts it, like any popup.
                    // The window never has focus, so this is the only way to know.
                    let _ = win.emit("click-outside", ());
                }
                was_down = down;

                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                // Once the window has shrunk to the wake strip, the strip is all
                // there is and it must take the mouse, whatever the stale island
                // rect says. Without this the poll's last tick could land after
                // set_collapsed had cleared the flag and set it right back —
                // leaving a strip nothing could ever wake.
                let accept = on_island || dragging || gate.collapsed.load(Ordering::Relaxed);
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dock(edge: &str, anchor: &str, offset: f64) -> Dock {
        Dock { edge: edge.into(), anchor: anchor.into(), offset, monitor: String::new() }
    }

    /// 1920×1080 with a 48 px taskbar at the bottom.
    const WA: Area = Area { x: 0, y: 0, w: 1920, h: 1032 };

    #[test]
    fn top_centre_is_where_the_island_always_was() {
        assert_eq!(window_rect(&Dock::default(), WA, 1.0, false), (300, 0, 1320, 320));
        assert_eq!(window_rect(&Dock::default(), WA, 1.0, true), (840, 0, 240, 6));
    }

    #[test]
    fn top_left_and_right_hug_the_work_area() {
        assert_eq!(window_rect(&dock("top", "start", 0.5), WA, 1.0, false), (0, 0, 1320, 320));
        assert_eq!(window_rect(&dock("top", "end", 0.5), WA, 1.0, false), (600, 0, 1320, 320));
        // The strip sits over the capsule's centre: 24 + 144 in, or out.
        assert_eq!(window_rect(&dock("top", "start", 0.5), WA, 1.0, true), (168 - 120, 0, 240, 6));
        assert_eq!(window_rect(&dock("top", "end", 0.5), WA, 1.0, true), (1920 - 168 - 120, 0, 240, 6));
    }

    #[test]
    fn a_window_wider_than_the_screen_still_starts_at_its_edge() {
        let small = Area { x: 0, y: 0, w: 1280, h: 680 };
        assert_eq!(window_rect(&dock("top", "start", 0.5), small, 1.0, false).0, 0);
        assert_eq!(window_rect(&dock("top", "end", 0.5), small, 1.0, false).0, 1280 - 1320);
    }

    #[test]
    fn side_docks_follow_the_offset_and_stay_on_screen() {
        let (x, y, w, h) = window_rect(&dock("left", "center", 0.5), WA, 1.0, false);
        assert_eq!((x, w, h), (0, 1320, 320));
        assert_eq!(y, 516 - 160);
        assert_eq!(anchor_in_window(&dock("left", "center", 0.5), WA, 1.0), 160.0);
        let (x, ..) = window_rect(&dock("right", "center", 0.5), WA, 1.0, false);
        assert_eq!(x, 1920 - 1320);
        // Near the top the window is clamped, and the anchor says where the capsule goes.
        let d = dock("left", "center", 0.0);
        assert_eq!(window_rect(&d, WA, 1.0, false).1, 0);
        assert_eq!(anchor_in_window(&d, WA, 1.0), 0.0);
        let d = dock("right", "center", 1.0);
        assert_eq!(window_rect(&d, WA, 1.0, false).1, 1032 - 320);
        assert_eq!(anchor_in_window(&d, WA, 1.0), 320.0);
    }

    #[test]
    fn a_side_wake_strip_stands_on_end() {
        let (x, y, w, h) = window_rect(&dock("left", "center", 0.5), WA, 1.0, true);
        assert_eq!((x, w, h), (0, 6, 240));
        assert_eq!(y, 516 - 120);
        let (x, _, w, h) = window_rect(&dock("right", "center", 0.5), WA, 1.0, true);
        assert_eq!((x, w, h), (1920 - 6, 6, 240));
    }

    #[test]
    fn scale_and_negative_coordinates() {
        // A 150 % display left of the primary one.
        let wa = Area { x: -2880, y: -200, w: 2880, h: 1560 };
        let (x, y, w, h) = window_rect(&Dock::default(), wa, 1.5, false);
        assert_eq!((w, h), (1980, 480));
        assert_eq!((x, y), (-2880 + (2880 - 1980) / 2, -200));
        let (x, y, w, h) = window_rect(&dock("right", "center", 0.5), wa, 1.5, true);
        assert_eq!((x, w, h), (-9, 9, 360));
        assert_eq!(y, -200 + 780 - 180);
        // Taskbar on top: the island sits under it.
        let wa = Area { x: 0, y: 48, w: 1920, h: 1032 };
        assert_eq!(window_rect(&Dock::default(), wa, 1.0, false).1, 48);
    }

    #[test]
    fn a_short_display_puts_a_side_dock_on_top_for_now() {
        let short = Area { x: 0, y: 0, w: 1920, h: 300 };
        let d = effective_dock(&dock("left", "center", 0.3), short, 1.0);
        assert_eq!((d.edge.as_str(), d.anchor.as_str()), ("top", "center"));
        assert_eq!(d.offset, 0.3);
        let d = effective_dock(&dock("left", "center", 0.3), WA, 1.0);
        assert_eq!(d.edge, "left");
    }

    #[test]
    fn the_island_finds_its_display() {
        let names: Vec<String> = ["A", "B", "C"].iter().map(|s| s.to_string()).collect();
        assert_eq!(pick_monitor(&names, Some(1), Some(2), "primary", "C"), Some(1));
        assert_eq!(pick_monitor(&names, Some(1), Some(2), "cursor", ""), Some(2));
        assert_eq!(pick_monitor(&names, Some(1), None, "cursor", ""), Some(1));
        assert_eq!(pick_monitor(&names, Some(1), Some(0), "docked", "C"), Some(2));
        // Unplugged: the primary, until it comes back.
        assert_eq!(pick_monitor(&names[..2], Some(1), Some(0), "docked", "C"), Some(1));
        assert_eq!(pick_monitor(&names, None, None, "primary", ""), Some(0));
        assert_eq!(pick_monitor(&[], None, None, "primary", ""), None);
    }
}
