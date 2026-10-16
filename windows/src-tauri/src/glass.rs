// A window of glass: what is behind it — the desktop, other windows — shows
// through, blurred, with a dark tint in Coucou's own colour over it.
//
// Windows has two ways to do this. The documented one (DWM's system
// backdrop, what Tauri's `effects()` uses on current builds) turns into a flat
// colour the moment the window loses focus, and the Teamwork window is looked
// at precisely while working in another one. So this goes through
// `SetWindowCompositionAttribute`, which user32 has exported unchanged since
// Windows 10 1809 and which keeps the blur whether the window is active or
// not. If the call is refused the window is simply transparent with no blur,
// and the page's own panels are dark enough to stay readable.

use std::ffi::c_void;

use tauri::WebviewWindow;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER};

const WCA_ACCENT_POLICY: u32 = 19;
const ACCENT_ENABLE_BLURBEHIND: u32 = 3;
const ACCENT_ENABLE_ACRYLICBLURBEHIND: u32 = 4;
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
const DWMWCP_ROUND: u32 = 2;
const DWMWA_NCRENDERING_POLICY: u32 = 2;
const DWMNCRP_DISABLED: u32 = 1;

#[repr(C)]
struct AccentPolicy {
    state: u32,
    flags: u32,
    /// 0xAABBGGRR.
    color: u32,
    animation: u32,
}

#[repr(C)]
struct CompositionData {
    attribute: u32,
    data: *mut c_void,
    size: usize,
}

/// `SetWindowCompositionAttribute(hwnd, data) -> BOOL`.
type SetComposition = unsafe extern "system" fn(HWND, *mut CompositionData) -> i32;

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleA(name: *const u8) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> Option<unsafe extern "system" fn() -> isize>;
}

/// The function is exported by user32.dll but not listed in its import
/// library, so it is looked up by name. user32 is always loaded in a process
/// that has a window.
fn set_composition() -> Option<SetComposition> {
    unsafe {
        let user32 = GetModuleHandleA(b"user32.dll\0".as_ptr());
        if user32.is_null() {
            return None;
        }
        let found = GetProcAddress(user32, b"SetWindowCompositionAttribute\0".as_ptr())?;
        Some(std::mem::transmute::<unsafe extern "system" fn() -> isize, SetComposition>(found))
    }
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: HWND, attribute: u32, value: *const c_void, size: u32) -> i32;
}

#[repr(C)]
struct OsVersionInfo {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform: u32,
    csd: [u16; 128],
}

#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
}

/// The real build number (GetVersion lies under compatibility shims; ntdll does not).
pub fn windows_build() -> u32 {
    unsafe {
        let mut v: OsVersionInfo = std::mem::zeroed();
        v.size = std::mem::size_of::<OsVersionInfo>() as u32;
        if RtlGetVersion(&mut v) == 0 {
            v.build
        } else {
            0
        }
    }
}

/// Windows 10: no DWM rounded corners, and the acrylic accent makes a window
/// all but undraggable (the compositor resamples the blur every frame of the
/// move loop). The same exe simply does without both there.
pub fn win10() -> bool {
    let b = windows_build();
    b > 0 && b < 22000
}

/// Blurs what is behind `win` and lays `tint` (0xAABBGGRR) over it.
pub fn apply(win: &WebviewWindow, tint: u32) {
    let Ok(raw) = win.hwnd() else { return };
    let hwnd = HWND(raw.0 as isize as *mut _);
    unsafe {
        if win10() {
            // Windows 10: acrylic resamples every frame of a move and the
            // window lags behind the mouse. The older blur does not, so it
            // stands in; the page lays the tint itself (html.win10), and the
            // corners are cut by a window region (round_corners).
            let mut policy = AccentPolicy { state: ACCENT_ENABLE_BLURBEHIND, flags: 0, color: 0, animation: 0 };
            let mut data = CompositionData {
                attribute: WCA_ACCENT_POLICY,
                data: (&mut policy as *mut AccentPolicy).cast(),
                size: std::mem::size_of::<AccentPolicy>(),
            };
            let blurred = set_composition().map(|set| set(hwnd, &mut data) != 0).unwrap_or(false);
            crate::log::line(if blurred { "glass: Windows 10 — classic blur behind" } else { "glass: Windows 10 — blur refused; plainly transparent" });
            // The window keeps a caption style (the windowing library's way
            // to an undecorated window), and Windows 10 draws that caption —
            // the title, – □ × — behind a page it can see through. Nothing
            // of the system frame is drawn: the page is the whole window.
            let off = DWMNCRP_DISABLED;
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_NCRENDERING_POLICY, (&off as *const u32).cast(), 4);
        } else {
            let mut policy = AccentPolicy { state: ACCENT_ENABLE_ACRYLICBLURBEHIND, flags: 0, color: tint, animation: 0 };
            let mut data = CompositionData {
                attribute: WCA_ACCENT_POLICY,
                data: (&mut policy as *mut AccentPolicy).cast(),
                size: std::mem::size_of::<AccentPolicy>(),
            };
            let blurred = set_composition().map(|set| set(hwnd, &mut data) != 0).unwrap_or(false);
            if !blurred {
                crate::log::line("glass: the blur was refused; the window stays plainly transparent");
            }
        }
        // No title bar, but still the rounded corners of a Windows 11 window.
        let round = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, (&round as *const u32).cast(), 4);
        // A window made hidden has its frame measured once, the standard way,
        // title bar included; asking for it to be measured again is what
        // lets the windowing library take the title bar away.
        let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateRoundRectRgn(x1: i32, y1: i32, x2: i32, y2: i32, w: i32, h: i32) -> *mut c_void;
    fn CreateRectRgn(x1: i32, y1: i32, x2: i32, y2: i32) -> *mut c_void;
}

#[link(name = "user32")]
extern "system" {
    fn SetWindowRgn(hwnd: HWND, rgn: *mut c_void, redraw: i32) -> i32;
}

/// Windows 10 has no DWM rounding: the window itself is cut to a rounded
/// rectangle (blur and all), over the page only — any frame around it is cut
/// away. Maximized, it keeps its square edges, and what a maximized window
/// has beyond the screen's edge (where a second display may be) is cut too.
/// Called on every resize, since a region is in pixels.
pub fn round_corners(win: &WebviewWindow) {
    if !win10() {
        return;
    }
    let Ok(raw) = win.hwnd() else { return };
    let hwnd = HWND(raw.0 as isize as *mut _);
    let (Ok(outer), Ok(inner), Ok(size)) = (win.outer_position(), win.inner_position(), win.inner_size()) else { return };
    // The page within the window, in the window's own pixels.
    let (x, y) = (inner.x - outer.x, inner.y - outer.y);
    let (w, h) = (size.width as i32, size.height as i32);
    let maximized = win.is_maximized().unwrap_or(false);
    unsafe {
        let rgn = if maximized {
            CreateRectRgn(x, y, x + w, y + h)
        } else {
            let scale = win.scale_factor().unwrap_or(1.0);
            let d = (16.0 * scale).round() as i32; // ellipse size = 2 × an 8 px radius
            CreateRoundRectRgn(x, y, x + w + 1, y + h + 1, d, d)
        };
        // The window owns the region from here on: it is not deleted.
        SetWindowRgn(hwnd, rgn, 1);
    }
}
