// The five worlds of 中二模式 (feature2 kit v4): each team's fight can be
// told in a battlefield of its own — a boss and its arena, fixed in pairs —
// or in the office with the old requirements golem. A world is a look and
// nothing else: the same tasks, the same HP, the same doors back to the real
// record, kept on this machine per team.

import { tr } from "../../../core/i18n";
import type { Id } from "../contracts";
import type { WorldBossId } from "./bossMoves";

export type WorldId = "office" | "lava_crater" | "frost_court" | "verdant_ruins" | "thunder_foundry" | "astral_rift";

export interface World {
  id: WorldId;
  bossId: WorldBossId | "requirements-golem";
  bossName: string;
  arenaName: string;
  /** The picker's words: the boss and its ground. */
  label: string;
  /** The boss's line under its name while the fight is on. */
  line: string;
  sealedLine: string;
  defeatedLine: string;
  palette: [string, string, string];
}

/** The words of each world are read when drawn, so they follow the language. */
export const WORLDS: Record<WorldId, World> = {
  office: {
    id: "office", bossId: "requirements-golem",
    get bossName() { return tr("需求魔王", "Requirements Overlord"); },
    get arenaName() { return tr("辦公室", "The Office"); },
    get label() { return tr("需求魔王・辦公室", "Requirements Overlord · The Office"); },
    get line() { return tr("需求越來越多…但我們一起扛!", "The asks keep piling up… but we carry them together!"); },
    get sealedLine() { return tr("工作都已驗收,等待 Leader 結案", "All work accepted, waiting for the Leader to close it out"); },
    get defeatedLine() { return tr("謝謝大家的努力,超棒的團隊!", "Thanks for all the hard work, amazing team!"); },
    palette: ["#B58CFF", "#FFD36B", "#6A2BE0"],
  },
  lava_crater: {
    id: "lava_crater", bossId: "lava-dragon",
    get bossName() { return tr("熔核龍王", "Molten Core Dragon"); },
    get arenaName() { return tr("熔岩龍巢", "Lava Lair"); },
    get label() { return tr("熔核龍王・熔岩龍巢", "Molten Core Dragon · Lava Lair"); },
    get line() { return tr("燃燒吧!讓我們打造更好的成果!", "Burn bright! Let's forge something even better!"); },
    get sealedLine() { return tr("熔紋暗下,雙翼收攏,等待 Leader 結案", "The magma veins dim, the wings fold, waiting for the Leader to close it out"); },
    get defeatedLine() { return tr("龍巢安靜了,留下熔晶龍徽", "The lair falls quiet, leaving a magma-crystal dragon crest"); },
    palette: ["#FF9B34", "#FFD272", "#A94C32"],
  },
  frost_court: {
    id: "frost_court", bossId: "frost-queen",
    get bossName() { return tr("霜鏡女王", "Frost Mirror Queen"); },
    get arenaName() { return tr("冰晶王庭", "Crystal Court"); },
    get label() { return tr("霜鏡女王・冰晶王庭", "Frost Mirror Queen · Crystal Court"); },
    get line() { return tr("映照需求,凍結猶豫的心!", "I mirror every ask and freeze every wavering heart!"); },
    get sealedLine() { return tr("鏡面靜止,晶冠低垂,等待 Leader 結案", "The mirror stills, the crystal crown bows, waiting for the Leader to close it out"); },
    get defeatedLine() { return tr("王庭融光,留下小霜晶王冠", "The court melts into light, leaving a tiny frost-crystal crown"); },
    palette: ["#91DBFF", "#D8F5FF", "#90A5E6"],
  },
  verdant_ruins: {
    id: "verdant_ruins", bossId: "root-king",
    get bossName() { return tr("纏根古王", "Ancient Root King"); },
    get arenaName() { return tr("森域遺跡", "Verdant Ruins"); },
    get label() { return tr("纏根古王・森域遺跡", "Ancient Root King · Verdant Ruins"); },
    get line() { return tr("糾結的記憶盤根,守護這片遺落的綠意!", "Tangled memories take root to guard this forgotten green!"); },
    get sealedLine() { return tr("根足收攏,苔冠垂下,等待 Leader 結案", "The roots curl in, the moss crown droops, waiting for the Leader to close it out"); },
    get defeatedLine() { return tr("遺跡回春,留下種晶木徽", "The ruins bloom again, leaving a seed-crystal wood crest"); },
    palette: ["#81C678", "#D3B981", "#369D79"],
  },
  thunder_foundry: {
    id: "thunder_foundry", bossId: "thunder-emperor",
    get bossName() { return tr("雷霆機皇", "Thunder Mech Emperor"); },
    get arenaName() { return tr("雷霆天工城", "Thunder Foundry"); },
    get label() { return tr("雷霆機皇・雷霆天工城", "Thunder Mech Emperor · Thunder Foundry"); },
    get line() { return tr("運轉雷霆之力,守護天工的機械秩序!", "Spin up the thunder and guard the foundry's iron order!"); },
    get sealedLine() { return tr("線圈停轉,電芯轉暗,等待 Leader 結案", "The coils stop, the cells go dark, waiting for the Leader to close it out"); },
    get defeatedLine() { return tr("天工城靜音,留下齒輪電晶徽", "The foundry goes silent, leaving a gear-crystal crest"); },
    palette: ["#76CEFA", "#D9B268", "#9F99FF"],
  },
  astral_rift: {
    id: "astral_rift", bossId: "astral-devourer",
    get bossName() { return tr("星噬之主", "Star Devourer"); },
    get arenaName() { return tr("星界裂隙", "Astral Rift"); },
    get label() { return tr("星噬之主・星界裂隙", "Star Devourer · Astral Rift"); },
    get line() { return tr("吞噬星光,讓更遠的可能成為現實!", "I devour starlight to make the far-off possible real!"); },
    get sealedLine() { return tr("星眼闔上,軌道環靜止,等待 Leader 結案", "The star eye shuts, the orbit rings still, waiting for the Leader to close it out"); },
    get defeatedLine() { return tr("裂隙閉合,留下星核月徽", "The rift closes, leaving a star-core moon crest"); },
    palette: ["#B693F0", "#E0B76F", "#6D69BB"],
  },
};

export const WORLD_IDS: WorldId[] = ["lava_crater", "frost_court", "verdant_ruins", "thunder_foundry", "astral_rift", "office"];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A team's battlefield: the person's choice for it, else the lava nest (the kit's default). */
export function savedWorld(teamId: Id): WorldId {
  // A browser opened at `?world=frost_court` starts there, to look at it.
  if (import.meta.env?.DEV && typeof location !== "undefined") {
    const q = new URLSearchParams(location.search).get("world") as WorldId | null;
    if (q && WORLDS[q]) return q;
  }
  const w = read(`coucou.battle.world.${teamId}`) as WorldId | null;
  return w && WORLDS[w] ? w : "lava_crater";
}

export function saveWorld(teamId: Id, world: WorldId) {
  try {
    localStorage.setItem(`coucou.battle.world.${teamId}`, world);
  } catch {
    /* kept until the window closes */
  }
}
