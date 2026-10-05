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
const ACCENT_ENABLE_ACRYLICBLURBEHIND: u32 = 4;
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
const DWMWCP_ROUND: u32 = 2;

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
            // The page paints its own dark, rounded sheet instead (html.win10).
            crate::log::line("glass: Windows 10 — no acrylic (it fights the move loop); the page tints itself");
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
