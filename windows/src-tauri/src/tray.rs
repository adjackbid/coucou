// Notification-area icon: Open, Teamwork, Settings, Pause, Reset island position, Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::island::WINDOW_LABEL;

/// The menu's items by id, kept so a language change can relabel them.
struct TrayItems(Vec<(&'static str, MenuItem<Wry>)>);

fn label(id: &str) -> String {
    match id {
        "open" => tr!("打開 Coucou", "Open Coucou"),
        "team" => tr!("Teamwork…", "Teamwork…"),
        "settings" => tr!("設定…", "Settings…"),
        "pause" => tr!("暫停", "Pause"),
        "reset-dock" => tr!("瀏海島回到預設位置", "Reset island position"),
        "quit" => tr!("結束", "Quit"),
        _ => String::new(),
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &'static str| MenuItem::with_id(app, id, label(id), true, None::<&str>);
    let open = item("open")?;
    let team = item("team")?;
    let settings = item("settings")?;
    let pause = item("pause")?;
    let reset = item("reset-dock")?;
    let quit = item("quit")?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &team, &sep1, &settings, &pause, &reset, &sep2, &quit])?;
    app.manage(TrayItems(vec![
        ("open", open.clone()),
        ("team", team.clone()),
        ("settings", settings.clone()),
        ("pause", pause.clone()),
        ("reset-dock", reset.clone()),
        ("quit", quit.clone()),
    ]));

    let mut builder = TrayIconBuilder::with_id("coucou")
        .tooltip("Coucou")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "team" => crate::show_team_window(app),
            "reset-dock" => crate::reset_island_position(app),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Puts the menu in the language now in use.
pub fn relabel(app: &AppHandle) {
    let Some(items) = app.try_state::<TrayItems>() else { return };
    for (id, item) in &items.0 {
        let _ = item.set_text(label(id));
    }
}
