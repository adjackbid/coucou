// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn inside a
// borderless, transparent, always-on-top window that never takes focus. The
// window sits against the edge the person docked the island to (settings.rs,
// `Dock`): the top (left, centre or right) or the left or right side.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::settings::{Dock, Settings};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON};
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
/// How much nearer another edge (or third of the top) must be before the
/// preview flips — keeps it from flickering around a corner.
pub const SNAP_HYSTERESIS: f64 = 24.0;
/// A side capsule dropped this close to the middle goes exactly to the middle.
pub const CENTRE_SNAP: f64 = 24.0;
/// The landing hint shows only while the cursor is this close to the edge.
pub const HINT_DISTANCE: f64 = 96.0;
/// After the capsule turns, the grab point slides back under its centre this fast.
const FLIP_SETTLE: Duration = Duration::from_millis(120);
/// A drop the front end never acknowledges still moves the window after this.
const COMMIT_GRACE: Duration = Duration::from_millis(300);

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
    /// The island being dragged, if it is.
    drag: Mutex<Option<Drag>>,
    /// A drop waiting for the front end (`commit_dock_geometry`) before the
    /// window moves, and when to give up waiting.
    pending: Mutex<Option<(Settings, Instant)>>,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
            drag: Mutex::new(None),
            pending: Mutex::new(None),
        }
    }

    pub fn dragging(&self) -> bool {
        self.drag.lock().unwrap().is_some()
    }

    /// Stops a drag without a drop (the island was put away mid-drag).
    pub fn abandon_drag(&self) {
        *self.drag.lock().unwrap() = None;
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

// ── Snapping ──────────────────────────────────────────────────────────────────
// The same rules and numbers as snapDock in src/core/dock.ts: change one side,
// change the other. Both test the same cases.

/// A rectangle in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct LRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The capsule's centre `oy` px down a work area `height` px tall, as a dock offset.
pub fn side_offset(oy: f64, height: f64) -> f64 {
    let lo = CAPSULE_LEN / 2.0 + SIDE_MARGIN;
    let hi = height - lo;
    if hi <= lo || height <= 0.0 {
        return 0.5;
    }
    if (oy - height / 2.0).abs() <= CENTRE_SNAP {
        return 0.5;
    }
    oy.clamp(lo, hi) / height
}

/// Where a capsule let go at `(x, y)` docks, in the logical coordinates of its
/// display's work area. There is no bottom edge: the nearest of the other
/// three wins. `prev` (edge, anchor) is the preview so far; nearly-equal
/// choices keep it.
pub fn snap_dock(x: f64, y: f64, wa: LRect, prev: Option<(&str, &str)>) -> Dock {
    let d_top = y - wa.y;
    let d_left = x - wa.x;
    let d_right = wa.x + wa.w - x;
    let side = if d_left <= d_right { "left" } else { "right" };
    let d_side = d_left.min(d_right);

    let prev_edge = prev.map(|p| p.0);
    let edge = match prev_edge {
        Some("top") => if d_side < d_top - SNAP_HYSTERESIS { side } else { "top" },
        Some("left") | Some("right") => if d_top < d_side - SNAP_HYSTERESIS { "top" } else { side },
        _ => if d_side < d_top { side } else { "top" },
    };

    if edge == "top" {
        let rx = x - wa.x;
        let b1 = wa.w / 3.0;
        let b2 = wa.w * 2.0 / 3.0;
        let mut anchor = if rx < b1 { "start" } else if rx > b2 { "end" } else { "center" };
        if let Some(("top", pa)) = prev {
            let h = SNAP_HYSTERESIS;
            if pa == "start" && rx < b1 + h {
                anchor = "start";
            } else if pa == "end" && rx > b2 - h {
                anchor = "end";
            } else if pa == "center" && rx >= b1 - h && rx <= b2 + h {
                anchor = "center";
            }
        }
        return Dock { edge: "top".into(), anchor: anchor.into(), offset: 0.5, monitor: String::new() };
    }
    Dock {
        edge: edge.into(),
        anchor: "center".into(),
        offset: side_offset(y - wa.y, wa.h),
        monitor: String::new(),
    }
}

fn edge_distance(x: f64, y: f64, wa: LRect, edge: &str) -> f64 {
    match edge {
        "left" => x - wa.x,
        "right" => wa.x + wa.w - x,
        _ => y - wa.y,
    }
}

// ── Dragging ──────────────────────────────────────────────────────────────────
// The poll thread drives a drag on its own: it already reads the cursor and
// the button every 16 ms, and the window takes no mouse input while it moves,
// so a fast fling loses nothing. The front end only says when it starts and
// draws the capsule turning.

/// One display as it was when the drag started.
#[derive(Clone)]
struct Screen {
    name: String,
    bounds: Area,
    wa: Area,
    scale: f64,
}

impl Screen {
    fn contains(&self, x: f64, y: f64) -> bool {
        let b = self.bounds;
        x >= b.x as f64 && x < (b.x + b.w as i32) as f64 && y >= b.y as f64 && y < (b.y + b.h as i32) as f64
    }

    fn logical_wa(&self) -> LRect {
        let s = self.scale;
        LRect { x: self.wa.x as f64 / s, y: self.wa.y as f64 / s, w: self.wa.w as f64 / s, h: self.wa.h as f64 / s }
    }
}

pub struct Drag {
    /// Cursor minus capsule centre, logical px.
    grab: (f64, f64),
    /// When the capsule last turned; the grab point then eases to its centre.
    flipped_at: Option<Instant>,
    preview: Dock,
    /// What to go back to on Escape.
    before: Settings,
    /// The display the island was on.
    home: String,
    screens: Vec<Screen>,
    /// Physical size last given to the window.
    size: (u32, u32),
    last_cursor: (f64, f64),
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreviewPayload {
    edge: String,
    anchor: String,
    /// Where the capsule will land, as a thin line along the edge, in the
    /// window's logical px; none when it is far away or out of the window.
    hint: Option<LRect>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DropPayload {
    dock: Dock,
    anchor_in_window: f64,
    /// The capsule where it was let go, in the coordinates of the window
    /// at its new place.
    from: LRect,
    cancelled: bool,
}

fn escape_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_ESCAPE.0 as i32) as u16 & 0x8000) != 0 }
}

fn screens(app: &AppHandle) -> Vec<Screen> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Screen {
            name: monitor_name(m),
            bounds: Area { x: m.position().x, y: m.position().y, w: m.size().width, h: m.size().height },
            wa: Area::of(m),
            scale: m.scale_factor(),
        })
        .collect()
}

fn capsule_size(vertical: bool) -> (f64, f64) {
    if vertical { (CAPSULE_THICK, CAPSULE_LEN) } else { (CAPSULE_LEN, CAPSULE_THICK) }
}

/// Starts dragging the island, the cursor `grab` logical px from the
/// capsule's centre. False when the button is already up — that was a click.
pub fn begin_drag(app: &AppHandle, gate: &PollGate, grab: (f64, f64)) -> bool {
    if !left_button_down() || gate.collapsed.load(Ordering::Relaxed) {
        return false;
    }
    let Some(shared) = app.try_state::<crate::Shared>() else { return false };
    let before = shared.settings.lock().unwrap().clone();
    let Some(m) = resolve_monitor(app, &before) else { return false };
    let preview = effective_dock(&before.dock, Area::of(&m), m.scale_factor());
    *gate.pending.lock().unwrap() = None;
    *gate.drag.lock().unwrap() = Some(Drag {
        grab,
        flipped_at: None,
        preview,
        before,
        home: monitor_name(&m),
        screens: screens(app),
        size: (0, 0),
        last_cursor: (f64::MIN, f64::MIN),
    });
    // The poll reads the mouse from here on; the window takes none of it.
    if let Some(win) = window(app) {
        gate.ignoring.store(true, Ordering::Relaxed);
        let _ = win.set_ignore_cursor_events(true);
    }
    gate.set_active(true);
    true
}

/// One poll tick of a drag: follow the cursor, preview the dock, or drop.
fn drag_tick(app: &AppHandle, gate: &PollGate, win: &WebviewWindow) {
    let Some((cx, cy)) = cursor_physical() else { return };
    let cancelled = escape_down();
    if cancelled || !left_button_down() {
        let Some(drag) = gate.drag.lock().unwrap().take() else { return };
        finish_drag(app, gate, win, drag, (cx, cy), cancelled);
        return;
    }

    let mut guard = gate.drag.lock().unwrap();
    let Some(drag) = guard.as_mut() else { return };
    let moved = (cx - drag.last_cursor.0).abs() >= 1.0 || (cy - drag.last_cursor.1).abs() >= 1.0;
    let settling = drag.flipped_at.is_some_and(|t| t.elapsed() < FLIP_SETTLE);
    if !moved && !settling {
        return;
    }
    drag.last_cursor = (cx, cy);

    let Some(screen) = drag
        .screens
        .iter()
        .find(|s| s.contains(cx, cy))
        .or_else(|| drag.screens.first())
        .cloned()
    else {
        return;
    };
    let scale = screen.scale;
    let grab = current_grab(drag);
    // The capsule's centre: what the snap is decided by, and what the window
    // keeps under the cursor.
    let (px_, py_) = (cx - grab.0 * scale, cy - grab.1 * scale);
    let wa = screen.logical_wa();
    let prev = (drag.preview.edge.clone(), drag.preview.anchor.clone());
    let mut next = snap_dock(px_ / scale, py_ / scale, wa, Some((&prev.0, &prev.1)));
    next = effective_dock(&next, screen.wa, scale);
    if next.is_vertical() != drag.preview.is_vertical() {
        // Turned on its side or back: the grab swaps axes and eases to the
        // middle, so the capsule stays under the cursor instead of jumping off.
        drag.grab = (grab.1, grab.0);
        drag.flipped_at = Some(Instant::now());
    }
    drag.preview = next.clone();

    let pw = px(PANEL_W, scale).max(1) as u32;
    let ph = px(PANEL_H, scale).max(1) as u32;
    let grab = current_grab(drag);
    let wx = (cx - grab.0 * scale - pw as f64 / 2.0).round() as i32;
    let wy = (cy - grab.1 * scale - ph as f64 / 2.0).round() as i32;
    // A display with another scale gives the window another physical size.
    if drag.size != (pw, ph) {
        drag.size = (pw, ph);
        let _ = win.set_size(PhysicalSize::new(pw, ph));
    }
    let _ = win.set_position(PhysicalPosition::new(wx, wy));

    // The landing line, while the cursor is near the edge and it is in the window.
    let near = edge_distance(cx / scale, cy / scale, wa, &next.edge) <= HINT_DISTANCE;
    let hint = if near {
        let (ox, oy, _, _) = window_rect(&next, screen.wa, scale, false);
        let (kx, ky, kw, kh) = capsule_in_window(&next, anchor_in_window(&next, screen.wa, scale));
        // In physical px on the screen, then in the dragged window's logical px.
        let (lx, ly) = (ox as f64 + kx * scale, oy as f64 + ky * scale);
        let line = match next.edge.as_str() {
            "left" => LRect { x: lx, y: ly, w: 3.0 * scale, h: kh * scale },
            "right" => LRect { x: lx + (kw - 3.0) * scale, y: ly, w: 3.0 * scale, h: kh * scale },
            _ => LRect { x: lx, y: ly, w: kw * scale, h: 3.0 * scale },
        };
        let r = LRect {
            x: (line.x - wx as f64) / scale,
            y: (line.y - wy as f64) / scale,
            w: line.w / scale,
            h: line.h / scale,
        };
        let inside = r.x + r.w > 0.0 && r.x < PANEL_W && r.y + r.h > 0.0 && r.y < PANEL_H;
        inside.then_some(r)
    } else {
        None
    };
    drop(guard);
    let _ = app.emit_to(
        WINDOW_LABEL,
        "dock-preview",
        PreviewPayload { edge: next.edge, anchor: next.anchor, hint },
    );
}

fn current_grab(drag: &Drag) -> (f64, f64) {
    match drag.flipped_at {
        Some(t) => {
            let k = 1.0 - (t.elapsed().as_secs_f64() / FLIP_SETTLE.as_secs_f64()).min(1.0);
            (drag.grab.0 * k, drag.grab.1 * k)
        }
        None => drag.grab,
    }
}

/// The drop: the dock is decided and saved, the front end is told where the
/// capsule was let go, and the window moves once it has drawn that (or after
/// `COMMIT_GRACE` regardless).
fn finish_drag(app: &AppHandle, gate: &PollGate, win: &WebviewWindow, drag: Drag, cursor: (f64, f64), cancelled: bool) {
    let screen = drag.screens.iter().find(|s| s.contains(cursor.0, cursor.1)).cloned();
    let mut settings = drag.before.clone();
    if !cancelled {
        if let Some(screen) = &screen {
            let mut dock = Dock { monitor: settings.dock.monitor.clone(), ..drag.preview.clone() };
            // Dropped on another display: the island now lives there ("docked").
            if screen.name != drag.home {
                settings.screen = "docked".into();
                dock.monitor = screen.name.clone();
            } else if settings.screen == "docked" {
                dock.monitor = screen.name.clone();
            }
            settings.dock = dock;
        }
        if let Some(shared) = app.try_state::<crate::Shared>() {
            let mut current = shared.settings.lock().unwrap();
            current.dock = settings.dock.clone();
            current.screen = settings.screen.clone();
            settings = current.clone();
            if let Err(err) = crate::settings::save(&current) {
                crate::log::line(format!("could not save the island's position: {err}"));
            }
        }
        crate::log::line(format!(
            "island docked {} {} {:.3} on {}",
            settings.dock.edge,
            settings.dock.anchor,
            settings.dock.offset,
            if settings.dock.monitor.is_empty() { "its display" } else { &settings.dock.monitor }
        ));
        let _ = app.emit("settings-changed", settings.clone());
    }

    // Where the window goes, on the display the settings now pick.
    let target = drag
        .screens
        .iter()
        .find(|s| {
            if settings.screen == "docked" && !settings.dock.monitor.is_empty() {
                s.name == settings.dock.monitor
            } else {
                s.name == drag.home
            }
        })
        .or(screen.as_ref())
        .or_else(|| drag.screens.first())
        .cloned();
    let payload = target.as_ref().map(|t| {
        let dock = effective_dock(&settings.dock, t.wa, t.scale);
        let (nx, ny, _, _) = window_rect(&dock, t.wa, t.scale, false);
        let anchor = anchor_in_window(&dock, t.wa, t.scale);
        // The capsule now: the middle of the dragged window.
        let (ox, oy) = win
            .outer_position()
            .map(|p| (p.x as f64, p.y as f64))
            .unwrap_or((nx as f64, ny as f64));
        let (dw, dh) = drag.size;
        let (mx, my) = (ox + dw as f64 / 2.0, oy + dh as f64 / 2.0);
        let (w, h) = capsule_size(dock.is_vertical());
        let from = LRect { x: (mx - nx as f64) / t.scale - w / 2.0, y: (my - ny as f64) / t.scale - h / 2.0, w, h };
        DropPayload { dock, anchor_in_window: anchor, from, cancelled }
    });

    *gate.pending.lock().unwrap() = Some((settings, Instant::now() + COMMIT_GRACE));
    if let Some(p) = payload {
        let _ = app.emit_to(WINDOW_LABEL, "dock-drop", p);
    }
}

/// The front end has drawn the capsule where it was let go: move the window.
pub fn commit_drop(app: &AppHandle, gate: &PollGate) {
    let Some((settings, _)) = gate.pending.lock().unwrap().take() else { return };
    let scale_before = window(app).and_then(|w| w.scale_factor().ok());
    apply_geometry(app, &settings, gate.collapsed.load(Ordering::Relaxed));
    // Click-through starts afresh from the island's new shape.
    if let Some(win) = window(app) {
        gate.ignoring.store(false, Ordering::Relaxed);
        let _ = win.set_ignore_cursor_events(false);
        // Another scale: the page has to fit itself to the window again.
        if win.scale_factor().ok() != scale_before {
            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
        }
    }
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

                // A drop the front end never answered still lands.
                let overdue = gate
                    .pending
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|(_, at)| Instant::now() >= *at);
                if overdue {
                    commit_drop(&app, &gate);
                    last = (f64::MIN, f64::MIN);
                }

                if gate.dragging() {
                    if let Some(win) = window(&app) {
                        drag_tick(&app, &gate, &win);
                    }
                    // No hover, no click-outside, no display check mid-drag.
                    was_down = true;
                    last = (f64::MIN, f64::MIN);
                    continue;
                }

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

    // The same cases as snapDock in src/core/dock.test.ts.
    const LWA: LRect = LRect { x: 0.0, y: 0.0, w: 1920.0, h: 1032.0 };

    fn snap(x: f64, y: f64, prev: Option<(&str, &str)>) -> Dock {
        snap_dock(x, y, LWA, prev)
    }

    #[test]
    fn snap_splits_the_top_into_three() {
        assert_eq!(snap(100.0, 5.0, None).anchor, "start");
        assert_eq!(snap(960.0, 5.0, None).anchor, "center");
        assert_eq!(snap(1800.0, 5.0, None).anchor, "end");
        assert_eq!(snap(1800.0, 5.0, None).edge, "top");
    }

    #[test]
    fn snap_docks_to_the_sides_on_screen() {
        let d = snap(3.0, 300.0, None);
        assert_eq!((d.edge.as_str(), d.offset), ("left", 300.0 / 1032.0));
        assert_eq!(snap(1915.0, 700.0, None).edge, "right");
        assert!((snap(3.0, 100.0, None).offset - 156.0 / 1032.0).abs() < 1e-9);
    }

    #[test]
    fn snap_never_docks_to_the_bottom() {
        assert_eq!(snap(900.0, 1000.0, None).edge, "left");
        let d = snap(1910.0, 1030.0, None);
        assert_eq!(d.edge, "right");
        assert!((d.offset - 876.0 / 1032.0).abs() < 1e-9);
        assert_eq!(snap(10.0, 1030.0, None).edge, "left");
    }

    #[test]
    fn snap_hysteresis_between_edges_and_thirds() {
        assert_eq!(snap(40.0, 50.0, Some(("top", "start"))).edge, "top");
        assert_eq!(snap(20.0, 50.0, Some(("top", "start"))).edge, "left");
        assert_eq!(snap(50.0, 40.0, Some(("left", "center"))).edge, "left");
        assert_eq!(snap(50.0, 20.0, Some(("left", "center"))).edge, "top");
        assert_eq!(snap(650.0, 5.0, Some(("top", "start"))).anchor, "start");
        assert_eq!(snap(670.0, 5.0, Some(("top", "start"))).anchor, "center");
        assert_eq!(snap(630.0, 5.0, Some(("top", "center"))).anchor, "center");
        assert_eq!(snap(610.0, 5.0, Some(("top", "center"))).anchor, "start");
        assert_eq!(snap(1290.0, 5.0, Some(("top", "center"))).anchor, "center");
        assert_eq!(snap(1310.0, 5.0, Some(("top", "center"))).anchor, "end");
        assert_eq!(snap(1270.0, 5.0, Some(("top", "end"))).anchor, "end");
        assert_eq!(snap(1250.0, 5.0, Some(("top", "end"))).anchor, "center");
    }

    #[test]
    fn snap_to_the_middle_and_off_origin_displays() {
        assert_eq!(snap(3.0, 536.0, None).offset, 0.5);
        assert_eq!(snap(3.0, 492.0, None).offset, 0.5);
        assert!((snap(3.0, 546.0, None).offset - 546.0 / 1032.0).abs() < 1e-9);
        let wa = LRect { x: -1920.0, y: -300.0, w: 1920.0, h: 1040.0 };
        let d = snap_dock(-1900.0, 100.0, wa, None);
        assert_eq!((d.edge.as_str(), d.offset), ("left", 400.0 / 1040.0));
        let d = snap_dock(-100.0, -295.0, wa, None);
        assert_eq!((d.edge.as_str(), d.anchor.as_str()), ("top", "end"));
        assert_eq!(snap_dock(-5.0, 200.0, wa, None).edge, "right");
        assert_eq!(side_offset(100.0, 250.0), 0.5);
    }

    #[test]
    fn the_capsule_lands_where_dock_ts_draws_it() {
        assert_eq!(capsule_in_window(&Dock::default(), 16.0), (516.0, 0.0, 288.0, 32.0));
        assert_eq!(capsule_in_window(&dock("top", "end", 0.5), 16.0).0, 1320.0 - 288.0 - 24.0);
        assert_eq!(capsule_in_window(&dock("left", "center", 0.5), 160.0), (0.0, 16.0, 32.0, 288.0));
        assert_eq!(capsule_in_window(&dock("right", "center", 0.5), 310.0), (1288.0, 32.0, 32.0, 288.0));
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
