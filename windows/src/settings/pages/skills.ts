// The Skill market: the skills Agent Center hands out and reads itself,
// kept as <name>\SKILL.md in %APPDATA%\Coucou\skills (team_agents.rs). Here
// the person writes a new one, changes or removes one, and copies in skills
// found in the usual places (~/.claude/skills and the like). Agent Pool, the
// team setup and Agent Center's proposals all pick from this list.

import { Bridge, IS_TAURI } from "../../core/bridge";
import { tr, trf } from "../../core/i18n";
import type { LibrarySkill } from "../../team/types";
import { h, clear } from "../../views/dom";
import type { Page } from "../nav";
import { card, errText, field, notice, pageHeader, row } from "../ui";

type Kind = "member" | "center";

/** What a new skill starts as: front matter Agent Center reads, then the instructions. */
function template(name: string, description: string, kind: Kind): string {
  const head = ["---", `name: ${name}`, `description: ${description}`, kind === "center" ? "for: agent-center" : "", "---"].filter(Boolean).join("\n");
  const body = kind === "center"
    ? tr("# {name}\n\n## 什麼時候用\n收到哪一類請求時,照這份 skill 分大小、挑人、切工。\n\n## 怎麼做\n1. …\n2. …", "# {name}\n\n## When\nFor which kind of request to size, staff and split the work this way.\n\n## How\n1. …\n2. …")
    : tr("# {name}\n\n## 什麼時候用\n做哪一類工作時用這份 skill。\n\n## 怎麼做\n1. …\n2. …\n\n## 交付\n做完要交出什麼、放在哪。", "# {name}\n\n## When\nWhich kind of work this skill is for.\n\n## How\n1. …\n2. …\n\n## Hand in\nWhat to deliver when done, and where.");
  return `${head}\n\n${body.replace(/\{name\}/g, name)}\n`;
}

export const skillsPage: Page = {
  id: "skills",
  icon: "skills",
  name: () => tr("Skill 市集", "Skill market"),
  render(ctx) {
    const root = h("div", { class: "stack" });
    let lib: LibrarySkill[] | null = null;
    let elsewhere: LibrarySkill[] = [];
    let editing: { name: string; text: string; isNew: boolean; description: string; kind: Kind } | null = null;
    let confirming: string | null = null;
    let busy = false;
    let said: { kind: "ok" | "err"; text: string } | null = null;

    const load = async () => {
      if (!IS_TAURI) {
        lib = [];
        draw();
        return;
      }
      lib = (await Bridge.teamSkillLibrary()) ?? [];
      elsewhere = (await Bridge.skillsElsewhere()) ?? [];
      draw();
    };

    const startNew = () => {
      editing = { name: "", text: "", isNew: true, description: "", kind: "member" };
      said = null;
      draw();
      requestAnimationFrame(() => (root.querySelector(".skill-name") as HTMLInputElement | null)?.focus());
    };

    const startEdit = async (s: LibrarySkill) => {
      said = null;
      try {
        const text = await Bridge.skillRead(s.name);
        editing = { name: s.name, text, isNew: false, description: s.description, kind: s.forCenter ? "center" : "member" };
      } catch (err) {
        said = { kind: "err", text: errText(err) };
      }
      draw();
    };

    const saveEdit = async () => {
      if (!editing || busy) return;
      const e = editing;
      const name = e.name.trim();
      const text = e.isNew && !e.text.trim() ? template(name, e.description.trim(), e.kind) : e.text;
      busy = true;
      draw();
      try {
        const saved = await Bridge.skillWrite(name, text);
        said = { kind: "ok", text: trf("已儲存「{name}」。", "Saved '{name}'.", { name: saved.name }) };
        editing = null;
        await load();
      } catch (err) {
        said = { kind: "err", text: errText(err) };
      }
      busy = false;
      draw();
    };

    const remove = async (s: LibrarySkill) => {
      if (confirming !== s.name) {
        confirming = s.name;
        draw();
        window.setTimeout(() => {
          if (confirming === s.name) {
            confirming = null;
            draw();
          }
        }, 5000);
        return;
      }
      confirming = null;
      busy = true;
      draw();
      try {
        await Bridge.skillDelete(s.name);
        said = { kind: "ok", text: trf("已刪除「{name}」。", "Removed '{name}'.", { name: s.name }) };
        if (editing?.name === s.name) editing = null;
        await load();
      } catch (err) {
        said = { kind: "err", text: errText(err) };
      }
      busy = false;
      draw();
    };

    const bring = async (s: LibrarySkill) => {
      busy = true;
      draw();
      try {
        const got = await Bridge.skillImport(s.path);
        said = { kind: "ok", text: trf("已把「{name}」加進市集。", "Added '{name}' to the market.", { name: got.name }) };
        await load();
      } catch (err) {
        said = { kind: "err", text: errText(err) };
      }
      busy = false;
      draw();
    };

    const kindTag = (center: boolean) => h("span", { class: `skill-kind${center ? " center" : ""}`, text: center ? tr("Agent Center 自己讀", "Agent Center's own") : tr("可派給成員", "For members") });

    const editor = (): HTMLElement => {
      const e = editing!;
      const textarea = h("textarea", { class: "skill-text", rows: "18", spellcheck: "false", placeholder: e.isNew ? tr("留空就用範本開始", "Leave empty to start from the template") : "", oninput: (ev: Event) => { e.text = (ev.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement;
      textarea.value = e.text;
      const kindPick = h("div", { class: "segmented", role: "group" },
        ...(["member", "center"] as Kind[]).map((k) => h("button", { type: "button", class: e.kind === k ? "on" : "", "aria-pressed": String(e.kind === k), onclick: () => { e.kind = k; draw(); } }, k === "member" ? tr("給成員", "For members") : tr("Agent Center 自己讀", "Agent Center's own"))));
      return h("div", { class: "stack skill-editor" },
        e.isNew
          ? field(tr("名稱", "Name"), h("input", { type: "text", class: "skill-name", value: e.name, placeholder: tr("例如:write-report、web-research", "e.g. write-report, web-research"), maxlength: "64", oninput: (ev: Event) => { e.name = (ev.target as HTMLInputElement).value; } }), tr("會成為資料夾名稱:中英文、數字、'-'、'_'、'.' 和空格。", "Becomes the folder's name: letters, digits, '-', '_', '.' and spaces."))
          : null,
        e.isNew ? field(tr("一句說明", "One line about it"), h("input", { type: "text", value: e.description, placeholder: tr("Agent Center 挑 skill 時看這一句", "Agent Center reads this line when it picks skills"), oninput: (ev: Event) => { e.description = (ev.target as HTMLInputElement).value; } })) : null,
        e.isNew ? field(tr("給誰", "Who it is for"), kindPick, tr("給成員的會寫進成員的開場說明;Agent Center 自己讀的(front matter for: agent-center)只影響它怎麼分大小、挑人、切工。", "A member skill goes into the member's opening brief; one for Agent Center (front matter for: agent-center) only shapes how it sizes, staffs and splits work.")) : null,
        field(e.isNew ? tr("內容", "Text") : tr("SKILL.md", "SKILL.md"), textarea, tr("Markdown。前面的 --- 區塊是給 Agent Center 看的 name / description / for;後面是給成員的做法。", "Markdown. The --- block at the top is name / description / for, for Agent Center; the rest is the how-to for members.")),
        row(
          h("button", { type: "button", class: "primary", disabled: busy || (e.isNew && !e.name.trim()), onclick: () => void saveEdit(), text: busy ? tr("儲存中…", "Saving…") : tr("儲存", "Save") }),
          h("button", { type: "button", disabled: busy, onclick: () => { editing = null; draw(); }, text: tr("取消", "Cancel") }),
        ));
    };

    const skillCard = (s: LibrarySkill): HTMLElement =>
      card({
        anchor: `skill-${s.name}`,
        title: s.name,
        badge: kindTag(s.forCenter),
        lead: s.description || tr("(沒有說明:在 SKILL.md 的 front matter 加一行 description)", "(No description: add a description line to the SKILL.md front matter)"),
        body: [
          editing && !editing.isNew && editing.name === s.name
            ? editor()
            : row(
                h("button", { type: "button", disabled: busy, onclick: () => void startEdit(s), text: tr("編輯", "Edit") }),
                h("button", { type: "button", class: confirming === s.name ? "danger" : "", disabled: busy, onclick: () => void remove(s), text: confirming === s.name ? tr("確定刪除?再按一次", "Delete? Press again") : tr("刪除", "Delete") }),
              ),
        ],
        details: () => h("div", { class: "details-grid" }, h("span", { text: tr("路徑", "Path") }), h("code", { class: "path", text: s.path })),
      });

    const draw = () => {
      clear(root);
      root.append(...[
        pageHeader(
          "skills",
          tr("Skill 市集", "Skill market"),
          tr("Agent 的做事手冊,一份一個資料夾。Agent Center 擬團隊時從這裡挑給組長或成員;Agent Pool 和團隊設定也從這裡勾。", "The agents' how-to sheets, one folder each. Agent Center picks from here when it proposes a team; Agent Pool and the team setup tick from the same list."),
          () => tr("每份 skill 是 %APPDATA%\\Coucou\\skills\\<名稱>\\SKILL.md。成員開工時會拿到被指定的 skill 全文;Agent Center 自己讀的(front matter 寫 for: agent-center)只影響它怎麼規劃,不會派給成員。你也可以直接在資料夾裡放檔案,按「重新整理」就看得到。", "Each skill is %APPDATA%\\Coucou\\skills\\<name>\\SKILL.md. A member gets the full text of the skills it was given as it starts; one Agent Center reads itself (front matter for: agent-center) only shapes its planning and is never handed out. Files put straight into the folder show up after Refresh."),
        ),
        said ? notice(said.kind, said.text) : null,
        h("div", { class: "add-row", "data-anchor": "skill-add" },
          h("button", { type: "button", class: "primary add-provider", disabled: busy || !!editing?.isNew, onclick: startNew, text: tr("＋ 新增 Skill", "+ New skill") }),
          h("span", { class: "hint", text: tr("寫一份新的做事手冊;或把下面「其他地方找到的」加進來。", "Write a new how-to, or bring in one found elsewhere below.") })),
        editing?.isNew ? card({ anchor: "skill-new", title: tr("新的 Skill", "New skill"), body: [editor()] }) : null,
        lib === null
          ? h("p", { class: "hint", text: tr("讀取中…", "Loading…") })
          : lib.length
            ? h("div", { class: "stack" }, ...lib.map(skillCard))
            : h("p", { class: "kind-empty", text: tr("市集還是空的。按上面的「新增 Skill」寫第一份。", "The market is empty. Write the first one with New skill above.") }),
        elsewhere.length
          ? card({
              anchor: "skills-elsewhere",
              title: tr("其他地方找到的", "Found elsewhere"),
              lead: tr("這台電腦的 ~/.claude/skills、~/.codex/skills、~/.agents/skills、~/.copilot/skills 裡有、但還不在市集的 skill。加進市集後,Agent Center 和團隊設定才挑得到。", "Skills in this PC's ~/.claude/skills, ~/.codex/skills, ~/.agents/skills or ~/.copilot/skills that are not in the market yet. Once added, Agent Center and the team setup can pick them."),
              body: [h("div", { class: "skill-found" }, ...elsewhere.map((s) =>
                h("div", { class: "skill-found-row" },
                  h("div", { class: "skill-found-text" }, h("b", { text: s.name }), h("small", { text: s.description || s.path })),
                  h("button", { type: "button", disabled: busy, onclick: () => void bring(s), text: tr("加進市集", "Add to market") }))))],
            })
          : null,
        row(
          h("button", { type: "button", disabled: !IS_TAURI, onclick: () => void Bridge.teamOpenSkills(), text: tr("開啟市集資料夾", "Open the market folder") }),
          h("button", { type: "button", disabled: busy, onclick: () => void load(), text: tr("重新整理", "Refresh") }),
        ),
      ].filter((x): x is HTMLElement => !!x));
    };

    draw();
    void load();
    if (ctx.action === "add") requestAnimationFrame(startNew);
    return root;
  },
};
