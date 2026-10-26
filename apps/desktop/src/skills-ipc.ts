import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent, Shell } from "electron";
import { isAppUrl } from "./policy.js";
import type { LocalSkillCatalog } from "./skills/catalog.js";

type Options = {
  ipc: Pick<IpcMain, "handle">;
  dialog: Pick<Dialog, "showOpenDialog">;
  shell: Pick<Shell, "showItemInFolder">;
  catalog: LocalSkillCatalog;
  getWindow(): BrowserWindow | undefined;
  getOrigin(): string;
};

export function registerLocalSkills(options: Options) {
  function trusted(event: IpcMainInvokeEvent) {
    const window = options.getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      !isAppUrl(event.senderFrame.url.split("#")[0] ?? "", options.getOrigin())) throw new Error("Untrusted local skills window");
    return window;
  }
  let changing = false;
  async function change<T>(event: IpcMainInvokeEvent, action: () => Promise<T>) {
    trusted(event);
    if (changing) throw new Error("已有本机技能操作正在进行，请稍后重试。");
    changing = true;
    try { return await action(); } finally { changing = false; }
  }
  options.ipc.handle("desktop:skills-list", event => { trusted(event); return options.catalog.list(); });
  options.ipc.handle("desktop:skills-read", (event, id: unknown) => { trusted(event); return options.catalog.read(id); });
  options.ipc.handle("desktop:skills-reveal", async (event, id: unknown) => {
    trusted(event);
    const path = await options.catalog.revealPath(id);
    trusted(event);
    options.shell.showItemInFolder(path);
  });
  options.ipc.handle("desktop:skills-remove-directory", (event, id: unknown) => change(event, () => options.catalog.removeRoot(id)));
  for (const action of ["add-directory", "import"] as const) {
    options.ipc.handle(`desktop:skills-${action}`, event => change(event, async () => {
      const window = trusted(event);
      const result = await options.dialog.showOpenDialog(window, {
        title: action === "import" ? "选择要导入的技能文件夹（包含 SKILL.md）" : "选择要扫描的技能目录",
        buttonLabel: action === "import" ? "导入技能" : "添加目录",
        properties: ["openDirectory"],
      });
      trusted(event);
      if (result.canceled || result.filePaths.length !== 1) return null;
      return action === "import" ? options.catalog.importFolder(result.filePaths[0]!) : options.catalog.addRoot(result.filePaths[0]!);
    }));
  }
}
