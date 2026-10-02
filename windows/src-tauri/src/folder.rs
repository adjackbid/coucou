// "Choose a folder": the system's own dialog, so a team's work folder is
// picked, not typed. COM's file dialog wants a thread of its own with an
// apartment; `pick` is called from one (see `pick_folder` in lib.rs).

use windows::core::HSTRING;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS,
    SIGDN_FILESYSPATH,
};

/// HRESULT_FROM_WIN32(ERROR_CANCELLED): the person closed the dialog.
const CANCELLED: i32 = 0x800704C7u32 as i32;

/// Shows the dialog over `owner`, opened on `start` when that folder exists.
/// `Ok(None)` when it was cancelled.
pub fn pick(owner: Option<isize>, start: &str, title: &str) -> Result<Option<String>, String> {
    unsafe {
        let initialised = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = show(owner, start, title);
        if initialised {
            CoUninitialize();
        }
        result
    }
}

unsafe fn show(owner: Option<isize>, start: &str, title: &str) -> Result<Option<String>, String> {
    let fail = |e: windows::core::Error| e.message().to_string();
    let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(fail)?;
    let options = dialog.GetOptions().map_err(fail)?;
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM).map_err(fail)?;
    let _ = dialog.SetTitle(&HSTRING::from(title));
    if !start.trim().is_empty() {
        if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(start.trim()), None) {
            let _ = dialog.SetFolder(&item);
        }
    }
    let owner = owner.map(|h| HWND(h as *mut _));
    if let Err(err) = dialog.Show(owner) {
        return if err.code().0 == CANCELLED { Ok(None) } else { Err(fail(err)) };
    }
    let item = dialog.GetResult().map_err(fail)?;
    let name = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(fail)?;
    let path = name.to_string().map_err(|e| e.to_string());
    CoTaskMemFree(Some(name.0 as *const _));
    path.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, PostMessageW, WM_CLOSE};

    /// Opens the real dialog and closes it again, as a person pressing Esc
    /// would. It needs a desktop, so it only runs when asked for:
    /// `cargo test -p coucou folder -- --ignored`.
    #[test]
    #[ignore]
    fn the_dialog_opens_and_a_cancel_is_not_an_error() {
        let title = "Coucou folder dialog test";
        let closer = std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                let found = unsafe { FindWindowW(None, &HSTRING::from(title)) };
                if let Ok(dialog) = found {
                    if !dialog.0.is_null() {
                        let _ = unsafe { PostMessageW(Some(dialog), WM_CLOSE, WPARAM(0), LPARAM(0)) };
                        return true;
                    }
                }
            }
            false
        });
        let picked = pick(None, &std::env::temp_dir().to_string_lossy(), title);
        assert!(closer.join().unwrap(), "the dialog never appeared");
        assert_eq!(picked, Ok(None));
    }
}
