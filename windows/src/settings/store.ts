// The settings window's copy of the preferences. Every page reads and writes
// this one object; Rust echoes each save back as `settings-changed`, which
// replaces it (see `live()` in the provider and agent cards).

import { Bridge } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";

export let settings: Settings = { ...DEFAULT_SETTINGS };
export let version = "";

export function replaceSettings(next: Settings) {
  settings = next;
}

export function setVersion(v: string) {
  version = v;
}

export async function save() {
  await Bridge.saveSettings(settings);
}
