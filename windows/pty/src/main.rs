//! coucou-pty — runs a CLI inside a pseudo console so Coucou can type into it.
//!
//! `coucou-pty [--label NAME] -- <command> [args…]`
//!
//! The CLI runs exactly as it would on its own: its screen is relayed to this
//! terminal byte for byte, and every key, paste and resize is relayed back.
//! The one addition is a named pipe, `\\.\pipe\coucou-pty-<pid>`, exported to
//! the CLI as `COUCOU_PTY` (the hook relay forwards it, which is how the
//! island learns which session lives in which terminal). Text written to that
//! pipe is typed into the CLI and submitted, as if the person had typed it.
//!
//! Hard rule, same as the hook's: never get in the way. If there is no real
//! console (output redirected, a CI run) or the pseudo console cannot be
//! created, the command is simply run directly and its exit code returned.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

type Handle = *mut c_void;

const STD_INPUT_HANDLE: u32 = -10i32 as u32;
const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
const ENABLE_PROCESSED_OUTPUT: u32 = 0x0001;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;
const DISABLE_NEWLINE_AUTO_RETURN: u32 = 0x0008;
const ENABLE_WINDOW_INPUT: u32 = 0x0008;
const ENABLE_INSERT_MODE: u32 = 0x0020;
const ENABLE_QUICK_EDIT_MODE: u32 = 0x0040;
const ENABLE_EXTENDED_FLAGS: u32 = 0x0080;
const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x0200;
const CP_UTF8: u32 = 65001;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const STARTF_USESTDHANDLES: u32 = 0x0100;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
const INFINITE: u32 = 0xFFFF_FFFF;
const PIPE_ACCESS_INBOUND: u32 = 0x0000_0001;
const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
const ERROR_PIPE_CONNECTED: u32 = 535;
const KEY_EVENT: u16 = 1;
const WINDOW_BUFFER_SIZE_EVENT: u16 = 4;
const VK_MENU: u16 = 0x12;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

/// Longest text accepted from the pipe in one go.
const MAX_INJECT: usize = 16 * 1024;

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Default)]
struct Coord {
    x: i16,
    y: i16,
}

#[repr(C)]
#[derive(Default)]
struct SmallRect {
    left: i16,
    top: i16,
    right: i16,
    bottom: i16,
}

#[repr(C)]
#[derive(Default)]
struct ScreenBufferInfo {
    size: Coord,
    cursor: Coord,
    attributes: u16,
    window: SmallRect,
    max: Coord,
}

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count: u32,
    y_count: u32,
    fill: u32,
    flags: u32,
    show: u16,
    cb_reserved2: u16,
    reserved2: *mut u8,
    std_in: Handle,
    std_out: Handle,
    std_err: Handle,
}

#[repr(C)]
struct StartupInfoExW {
    startup: StartupInfoW,
    attributes: *mut c_void,
}

#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    pid: u32,
    tid: u32,
}

/// `INPUT_RECORD`: an event type and a 16-byte union.
#[repr(C)]
#[derive(Clone, Copy)]
struct InputRecord {
    event_type: u16,
    _pad: u16,
    data: [u8; 16],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct KeyEvent {
    down: i32,
    repeat: u16,
    vk: u16,
    scan: u16,
    ch: u16,
    control: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetStdHandle(n: u32) -> Handle;
    fn GetConsoleMode(h: Handle, mode: *mut u32) -> i32;
    fn SetConsoleMode(h: Handle, mode: u32) -> i32;
    fn GetConsoleScreenBufferInfo(h: Handle, info: *mut ScreenBufferInfo) -> i32;
    fn GetConsoleCP() -> u32;
    fn GetConsoleOutputCP() -> u32;
    fn SetConsoleCP(cp: u32) -> i32;
    fn SetConsoleOutputCP(cp: u32) -> i32;
    fn ReadConsoleInputW(h: Handle, buf: *mut InputRecord, len: u32, read: *mut u32) -> i32;
    fn CreatePipe(read: *mut Handle, write: *mut Handle, attrs: *mut c_void, size: u32) -> i32;
    fn CreatePseudoConsole(size: Coord, input: Handle, output: Handle, flags: u32, hpc: *mut Handle) -> i32;
    fn ResizePseudoConsole(hpc: Handle, size: Coord) -> i32;
    fn ClosePseudoConsole(hpc: Handle);
    fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous: *mut c_void,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        application: *const u16,
        command_line: *mut u16,
        process_attrs: *mut c_void,
        thread_attrs: *mut c_void,
        inherit: i32,
        flags: u32,
        environment: *mut c_void,
        directory: *const u16,
        startup: *mut StartupInfoW,
        info: *mut ProcessInformation,
    ) -> i32;
    fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
    fn GetExitCodeProcess(h: Handle, code: *mut u32) -> i32;
    fn CloseHandle(h: Handle) -> i32;
    fn ReadFile(h: Handle, buf: *mut u8, len: u32, read: *mut u32, overlapped: *mut c_void) -> i32;
    fn WriteFile(h: Handle, buf: *const u8, len: u32, written: *mut u32, overlapped: *mut c_void) -> i32;
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_size: u32,
        in_size: u32,
        timeout: u32,
        security: *mut c_void,
    ) -> Handle;
    fn ConnectNamedPipe(h: Handle, overlapped: *mut c_void) -> i32;
    fn DisconnectNamedPipe(h: Handle) -> i32;
    fn GetLastError() -> u32;
}

// ── Command line ──────────────────────────────────────────────────────────────

struct Invocation {
    program: String,
    args: Vec<String>,
}

/// `[--label NAME] -- <command> [args…]`; without `--`, everything is the command.
fn parse(args: &[String]) -> Option<Invocation> {
    let rest: &[String] = match args.iter().position(|a| a == "--") {
        Some(i) => &args[i + 1..],
        None => {
            let mut i = 0;
            while i < args.len() && args[i].starts_with("--") {
                i += if args[i].contains('=') { 1 } else { 2 };
            }
            args.get(i..).unwrap_or(&[])
        }
    };
    let (program, args) = rest.split_first()?;
    Some(Invocation { program: program.clone(), args: args.to_vec() })
}

/// Our own `where`: %PATH% against %PATHEXT%, so `copilot` finds `copilot.cmd`
/// and never the extensionless shell script npm puts beside it.
fn resolve(program: &str) -> Option<PathBuf> {
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_lowercase())
        .collect();
    let candidates = |base: &Path| -> Option<PathBuf> {
        if base.extension().is_some() && base.is_file() {
            return Some(base.to_path_buf());
        }
        exts.iter()
            .map(|ext| PathBuf::from(format!("{}{ext}", base.display())))
            .find(|p| p.is_file())
    };
    let p = Path::new(program);
    if p.is_absolute() || program.contains('\\') || program.contains('/') {
        return candidates(p);
    }
    let dirs = std::env::var_os("PATH")?;
    std::env::split_paths(&dirs).find_map(|dir| candidates(&dir.join(program)))
}

/// One argument, quoted the way the C runtime will un-quote it.
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                backslashes = 0;
                out.push('"');
                continue;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
            }
        }
        if c != '\\' {
            out.push(c);
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// The command line CreateProcessW gets. A `.cmd`/`.bat` cannot be started
/// directly; it goes through `cmd.exe /d /s /c "…"`.
fn command_line(resolved: &Path, args: &[String]) -> String {
    let mut line = quote(&resolved.to_string_lossy());
    for a in args {
        line.push(' ');
        line.push_str(&quote(a));
    }
    let ext = resolved
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext == "cmd" || ext == "bat" {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        return format!("{} /d /s /c \"{line}\"", quote(&shell));
    }
    line
}

// ── Bytes in and out ──────────────────────────────────────────────────────────

/// How much of `buf` is whole UTF-8: a multi-byte character cut by the end of
/// a read is held back for the next write, or the terminal shows garbage.
fn utf8_complete_len(buf: &[u8]) -> usize {
    let len = buf.len();
    for back in 1..=len.min(4) {
        let i = len - back;
        let b = buf[i];
        if b < 0x80 {
            return len;
        }
        if b >= 0xC0 {
            let need = if b >= 0xF0 { 4 } else if b >= 0xE0 { 3 } else { 2 };
            return if back >= need { len } else { i };
        }
    }
    len
}

/// The character a key event types, if any. Key-up events carry nothing —
/// except Alt releases, which is how Alt+numpad and some pastes deliver theirs.
fn key_char(k: &KeyEvent) -> Option<u16> {
    if k.ch == 0 {
        return None;
    }
    if k.down != 0 || k.vk == VK_MENU {
        return Some(k.ch);
    }
    None
}

/// UTF-16 units → UTF-8, keeping a trailing high surrogate for the next read.
fn drain_utf16(pending: &mut Vec<u16>) -> Vec<u8> {
    let keep = match pending.last() {
        Some(u) if (0xD800..0xDC00).contains(u) => 1,
        _ => 0,
    };
    let take = pending.len() - keep;
    let text: String = char::decode_utf16(pending[..take].iter().copied())
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    pending.drain(..take);
    text.into_bytes()
}

/// What gets typed for a text sent through the pipe: the text itself — as a
/// bracketed paste when it has line breaks, so they do not submit half of it.
/// The Enter that submits is sent separately, a moment later.
fn injection(text: &str) -> Vec<u8> {
    let text = text.trim_end_matches(['\r', '\n']);
    if text.contains('\n') || text.contains('\r') {
        format!("\x1b[200~{text}\x1b[201~").into_bytes()
    } else {
        text.as_bytes().to_vec()
    }
}

/// A handle that may cross threads. They are plain kernel object references.
#[derive(Clone, Copy)]
struct Shared(usize);
impl Shared {
    fn of(h: Handle) -> Self {
        Shared(h as usize)
    }
    fn get(self) -> Handle {
        self.0 as Handle
    }
}

unsafe fn write_all(h: Handle, mut bytes: &[u8]) -> bool {
    while !bytes.is_empty() {
        let mut written = 0u32;
        if WriteFile(h, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut()) == 0 || written == 0 {
            return false;
        }
        bytes = &bytes[written as usize..];
    }
    true
}

unsafe fn window_size(hout: Handle) -> Coord {
    let mut info = ScreenBufferInfo::default();
    if GetConsoleScreenBufferInfo(hout, &mut info) == 0 {
        return Coord { x: 120, y: 30 };
    }
    Coord {
        x: (info.window.right - info.window.left + 1).max(1),
        y: (info.window.bottom - info.window.top + 1).max(1),
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ── Running ───────────────────────────────────────────────────────────────────

/// No console, or no pseudo console: run the command as if we were not here.
fn passthrough(resolved: &Path, args: &[String]) -> i32 {
    match std::process::Command::new(resolved).args(args).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            eprintln!("coucou-pty: could not start {}: {err}", resolved.display());
            127
        }
    }
}

unsafe fn run(resolved: &Path, args: &[String]) -> i32 {
    let hin = GetStdHandle(STD_INPUT_HANDLE);
    let hout = GetStdHandle(STD_OUTPUT_HANDLE);
    let (mut in_mode, mut out_mode) = (0u32, 0u32);
    if GetConsoleMode(hin, &mut in_mode) == 0 || GetConsoleMode(hout, &mut out_mode) == 0 {
        return passthrough(resolved, args);
    }

    let (mut in_read, mut in_write) = (std::ptr::null_mut(), std::ptr::null_mut());
    let (mut out_read, mut out_write) = (std::ptr::null_mut(), std::ptr::null_mut());
    if CreatePipe(&mut in_read, &mut in_write, std::ptr::null_mut(), 0) == 0
        || CreatePipe(&mut out_read, &mut out_write, std::ptr::null_mut(), 0) == 0
    {
        return passthrough(resolved, args);
    }
    let mut hpc: Handle = std::ptr::null_mut();
    if CreatePseudoConsole(window_size(hout), in_read, out_write, 0, &mut hpc) < 0 {
        return passthrough(resolved, args);
    }

    // The attribute list that attaches the child to the pseudo console.
    let mut list_size = 0usize;
    InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut list_size);
    let mut list = vec![0u8; list_size];
    let list_ptr = list.as_mut_ptr() as *mut c_void;
    if InitializeProcThreadAttributeList(list_ptr, 1, 0, &mut list_size) == 0
        || UpdateProcThreadAttribute(
            list_ptr,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            hpc,
            std::mem::size_of::<Handle>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
    {
        ClosePseudoConsole(hpc);
        return passthrough(resolved, args);
    }

    // The pipe Coucou types through; the child (and its hooks) learn its name.
    let pipe_name = format!(r"\\.\pipe\coucou-pty-{}", std::process::id());
    std::env::set_var("COUCOU_PTY", &pipe_name);

    let mut startup: StartupInfoExW = std::mem::zeroed();
    startup.startup.cb = std::mem::size_of::<StartupInfoExW>() as u32;
    // Null std handles on purpose: without this flag a redirected handle of
    // ours would be inherited instead of the pseudo console's.
    startup.startup.flags = STARTF_USESTDHANDLES;
    startup.attributes = list_ptr;
    let mut info: ProcessInformation = std::mem::zeroed();
    let mut line = wide(&command_line(resolved, args));
    let created = CreateProcessW(
        std::ptr::null(),
        line.as_mut_ptr(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        0,
        EXTENDED_STARTUPINFO_PRESENT,
        std::ptr::null_mut(),
        std::ptr::null(),
        &mut startup.startup,
        &mut info,
    );
    DeleteProcThreadAttributeList(list_ptr);
    CloseHandle(in_read);
    CloseHandle(out_write);
    if created == 0 {
        let err = GetLastError();
        ClosePseudoConsole(hpc);
        eprintln!("coucou-pty: could not start {} (error {err})", resolved.display());
        return 127;
    }
    CloseHandle(info.thread);

    // This terminal becomes a plain wire: keys in as VT, bytes out as VT, UTF-8.
    let (in_cp, out_cp) = (GetConsoleCP(), GetConsoleOutputCP());
    SetConsoleCP(CP_UTF8);
    SetConsoleOutputCP(CP_UTF8);
    let keep = in_mode & (ENABLE_QUICK_EDIT_MODE | ENABLE_EXTENDED_FLAGS | ENABLE_INSERT_MODE);
    SetConsoleMode(hin, keep | ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT);
    SetConsoleMode(
        hout,
        out_mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN,
    );

    // Everything typed — by the keyboard or by Coucou — goes down one pipe.
    let to_child = Arc::new(Mutex::new(Shared::of(in_write)));

    // Screen: child → this terminal.
    let (done_tx, done_rx) = mpsc::channel::<()>();
    {
        let (src, dst) = (Shared::of(out_read), Shared::of(hout));
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            let mut held = 0usize;
            loop {
                let mut read = 0u32;
                let ok = ReadFile(
                    src.get(),
                    buf.as_mut_ptr().add(held),
                    (buf.len() - held) as u32,
                    &mut read,
                    std::ptr::null_mut(),
                );
                if ok == 0 || read == 0 {
                    break;
                }
                let have = held + read as usize;
                let whole = utf8_complete_len(&buf[..have]);
                if !write_all(dst.get(), &buf[..whole]) {
                    break;
                }
                buf.copy_within(whole..have, 0);
                held = have - whole;
            }
            let _ = done_tx.send(());
        });
    }

    // Keyboard: this terminal → child, and resizes along with it.
    {
        let (src, out, pty) = (Shared::of(hin), Shared::of(hout), Shared::of(hpc));
        let to_child = to_child.clone();
        std::thread::spawn(move || {
            let mut records = [InputRecord { event_type: 0, _pad: 0, data: [0; 16] }; 128];
            let mut pending: Vec<u16> = Vec::new();
            let mut size = window_size(out.get());
            loop {
                let mut read = 0u32;
                if ReadConsoleInputW(src.get(), records.as_mut_ptr(), records.len() as u32, &mut read) == 0 {
                    break;
                }
                let mut resized = false;
                for record in &records[..read as usize] {
                    match record.event_type {
                        KEY_EVENT => {
                            let key: KeyEvent = std::ptr::read_unaligned(record.data.as_ptr() as *const KeyEvent);
                            if let Some(ch) = key_char(&key) {
                                for _ in 0..key.repeat.max(1) {
                                    pending.push(ch);
                                }
                            }
                        }
                        WINDOW_BUFFER_SIZE_EVENT => resized = true,
                        _ => {}
                    }
                }
                let bytes = drain_utf16(&mut pending);
                if !bytes.is_empty() && !write_all(to_child.lock().unwrap().get(), &bytes) {
                    break;
                }
                if resized {
                    let now = window_size(out.get());
                    if now != size {
                        size = now;
                        ResizePseudoConsole(pty.get(), now);
                    }
                }
            }
        });
    }

    // Coucou: text written to the pipe is typed, then submitted.
    {
        let to_child = to_child.clone();
        let name = wide(&pipe_name);
        std::thread::spawn(move || {
            // Inbound only, one instance, local clients only. The default
            // security descriptor lets nobody but this user write to it.
            let pipe = CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_REJECT_REMOTE_CLIENTS,
                1,
                0,
                MAX_INJECT as u32,
                0,
                std::ptr::null_mut(),
            );
            if pipe == INVALID_HANDLE_VALUE || pipe.is_null() {
                return;
            }
            loop {
                if ConnectNamedPipe(pipe, std::ptr::null_mut()) == 0 && GetLastError() != ERROR_PIPE_CONNECTED {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                let mut text = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let mut read = 0u32;
                    if ReadFile(pipe, chunk.as_mut_ptr(), chunk.len() as u32, &mut read, std::ptr::null_mut()) == 0
                        || read == 0
                    {
                        break;
                    }
                    text.extend_from_slice(&chunk[..read as usize]);
                    if text.len() >= MAX_INJECT {
                        break;
                    }
                }
                DisconnectNamedPipe(pipe);
                let text = String::from_utf8_lossy(&text[..text.len().min(MAX_INJECT)]).to_string();
                if text.trim().is_empty() {
                    continue;
                }
                let h = to_child.lock().unwrap().get();
                if write_all(h, &injection(&text)) {
                    // A beat between the text and the Enter: a TUI that reads
                    // them in one gulp can take the Enter for part of a paste.
                    std::thread::sleep(Duration::from_millis(120));
                    write_all(to_child.lock().unwrap().get(), b"\r");
                }
            }
        });
    }

    WaitForSingleObject(info.process, INFINITE);
    let mut code = 0u32;
    GetExitCodeProcess(info.process, &mut code);
    CloseHandle(info.process);

    // Closing the pseudo console flushes what is left of the screen; give the
    // relay a moment to print it before the terminal is handed back.
    ClosePseudoConsole(hpc);
    let _ = done_rx.recv_timeout(Duration::from_secs(2));

    SetConsoleMode(hin, in_mode);
    SetConsoleMode(hout, out_mode);
    SetConsoleCP(in_cp);
    SetConsoleOutputCP(out_cp);
    code as i32
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(invocation) = parse(&args) else {
        eprintln!("usage: coucou-pty [--label NAME] -- <command> [args…]");
        std::process::exit(2);
    };
    let Some(resolved) = resolve(&invocation.program) else {
        eprintln!("coucou-pty: '{}' was not found on PATH", invocation.program);
        std::process::exit(127);
    };
    let code = unsafe { run(&resolved, &invocation.args) };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn the_command_is_what_follows_the_double_dash() {
        let inv = parse(&s(&["--label", "cg", "--", "copilot", "--yolo", "-p", "hi"])).unwrap();
        assert_eq!(inv.program, "copilot");
        assert_eq!(inv.args, s(&["--yolo", "-p", "hi"]));
        // Without the separator, our own options are skipped and the rest is the command.
        let inv = parse(&s(&["--label", "cg", "copilot", "--yolo"])).unwrap();
        assert_eq!(inv.program, "copilot");
        assert_eq!(inv.args, s(&["--yolo"]));
        assert!(parse(&s(&["--"])).is_none());
        assert!(parse(&[]).is_none());
    }

    #[test]
    fn arguments_are_quoted_the_way_the_c_runtime_reads_them() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("two words"), "\"two words\"");
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(r"C:\dir with space\"), r#""C:\dir with space\\""#);
    }

    #[test]
    fn a_batch_file_goes_through_cmd() {
        std::env::set_var("ComSpec", r"C:\Windows\System32\cmd.exe");
        let line = command_line(Path::new(r"C:\npm\copilot.cmd"), &s(&["--yolo", "two words"]));
        assert_eq!(line, r#"C:\Windows\System32\cmd.exe /d /s /c "C:\npm\copilot.cmd --yolo "two words"""#);
        let line = command_line(Path::new(r"C:\bin\agy.exe"), &s(&["-p", "x"]));
        assert_eq!(line, r"C:\bin\agy.exe -p x");
    }

    #[test]
    fn a_cut_character_is_held_back() {
        let text = "測試".as_bytes(); // 6 bytes, two 3-byte characters
        assert_eq!(utf8_complete_len(text), 6);
        assert_eq!(utf8_complete_len(&text[..5]), 3);
        assert_eq!(utf8_complete_len(&text[..4]), 3);
        assert_eq!(utf8_complete_len(b"abc"), 3);
        assert_eq!(utf8_complete_len(&[b'a', 0xF0, 0x9F]), 1); // half an emoji
        assert_eq!(utf8_complete_len("a👋".as_bytes()), 5);
        assert_eq!(utf8_complete_len(&[]), 0);
    }

    #[test]
    fn keys_become_utf8_across_reads() {
        let key = |down: i32, vk: u16, ch: u16| KeyEvent { down, repeat: 1, vk, scan: 0, ch, control: 0 };
        assert_eq!(key_char(&key(1, 0x41, 'a' as u16)), Some('a' as u16));
        assert_eq!(key_char(&key(0, 0x41, 'a' as u16)), None);
        assert_eq!(key_char(&key(1, 0x10, 0)), None); // Shift alone
        assert_eq!(key_char(&key(0, VK_MENU, 0x6E2C)), Some(0x6E2C)); // Alt release carrying 測

        // A surrogate pair split over two reads comes out whole.
        let wave: Vec<u16> = "👋".encode_utf16().collect();
        let mut pending = vec!['a' as u16, wave[0]];
        assert_eq!(drain_utf16(&mut pending), b"a");
        assert_eq!(pending, vec![wave[0]]);
        pending.push(wave[1]);
        assert_eq!(drain_utf16(&mut pending), "👋".as_bytes());
        assert!(pending.is_empty());
    }

    #[test]
    fn injected_text_is_typed_once_and_multi_line_text_is_pasted() {
        assert_eq!(injection("run the tests\r\n"), b"run the tests");
        assert_eq!(injection("a\nb"), b"\x1b[200~a\nb\x1b[201~");
    }
}
