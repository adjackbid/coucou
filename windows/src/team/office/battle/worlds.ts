// The five worlds of 中二模式 (feature2 kit v4): each team's fight can be
// told in a battlefield of its own — a boss and its arena, fixed in pairs —
// or in the office with the old requirements golem. A world is a look and
// nothing else: the same tasks, the same HP, the same doors back to the real
// record, kept on this machine per team.

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

export const WORLDS: Record<WorldId, World> = {
  office: {
    id: "office", bossId: "requirements-golem", bossName: "需求魔王", arenaName: "辦公室",
    label: "需求魔王・辦公室",
    line: "需求越來越多…但我們一起扛!",
    sealedLine: "工作都已驗收,等待 Leader 結案",
    defeatedLine: "謝謝大家的努力,超棒的團隊!",
    palette: ["#B58CFF", "#FFD36B", "#6A2BE0"],
  },
  lava_crater: {
    id: "lava_crater", bossId: "lava-dragon", bossName: "熔核龍王", arenaName: "熔岩龍巢",
    label: "熔核龍王・熔岩龍巢",
    line: "燃燒吧!讓我們打造更好的成果!",
    sealedLine: "熔紋暗下,雙翼收攏,等待 Leader 結案",
    defeatedLine: "龍巢安靜了,留下熔晶龍徽",
    palette: ["#FF9B34", "#FFD272", "#A94C32"],
  },
  frost_court: {
    id: "frost_court", bossId: "frost-queen", bossName: "霜鏡女王", arenaName: "冰晶王庭",
    label: "霜鏡女王・冰晶王庭",
    line: "映照需求,凍結猶豫的心!",
    sealedLine: "鏡面靜止,晶冠低垂,等待 Leader 結案",
    defeatedLine: "王庭融光,留下小霜晶王冠",
    palette: ["#91DBFF", "#D8F5FF", "#90A5E6"],
  },
  verdant_ruins: {
    id: "verdant_ruins", bossId: "root-king", bossName: "纏根古王", arenaName: "森域遺跡",
    label: "纏根古王・森域遺跡",
    line: "糾結的記憶盤根,守護這片遺落的綠意!",
    sealedLine: "根足收攏,苔冠垂下,等待 Leader 結案",
    defeatedLine: "遺跡回春,留下種晶木徽",
    palette: ["#81C678", "#D3B981", "#369D79"],
  },
  thunder_foundry: {
    id: "thunder_foundry", bossId: "thunder-emperor", bossName: "雷霆機皇", arenaName: "雷霆天工城",
    label: "雷霆機皇・雷霆天工城",
    line: "運轉雷霆之力,守護天工的機械秩序!",
    sealedLine: "線圈停轉,電芯轉暗,等待 Leader 結案",
    defeatedLine: "天工城靜音,留下齒輪電晶徽",
    palette: ["#76CEFA", "#D9B268", "#9F99FF"],
  },
  astral_rift: {
    id: "astral_rift", bossId: "astral-devourer", bossName: "星噬之主", arenaName: "星界裂隙",
    label: "星噬之主・星界裂隙",
    line: "吞噬星光,讓更遠的可能成為現實!",
    sealedLine: "星眼闔上,軌道環靜止,等待 Leader 結案",
    defeatedLine: "裂隙閉合,留下星核月徽",
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
