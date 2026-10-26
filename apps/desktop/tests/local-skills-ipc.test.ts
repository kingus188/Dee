import assert from "node:assert/strict";
import test from "node:test";
import { registerLocalSkills } from "../dist/skills-ipc.js";

type Options = Parameters<typeof registerLocalSkills>[0];
function fixture() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const calls: string[] = [];
  const frame = { url: "https://assistant.example/#skills" };
  const sender = { mainFrame: frame };
  let destroyed = false;
  const window = { webContents: sender, isDestroyed: () => destroyed };
  let selected: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: ["/chosen/skills"] };
  let picker: (() => Promise<typeof selected>) | undefined;
  const catalog = {
    list: async () => { calls.push("list"); return { roots: [], skills: [], warnings: [] }; },
    read: async (id: unknown) => { calls.push(`read:${String(id)}`); return {}; },
    revealPath: async () => { calls.push("reveal"); return "/known/skill/SKILL.md"; },
    addRoot: async (path: string) => { calls.push(`add:${path}`); return {}; },
    removeRoot: async (id: unknown) => { calls.push(`remove:${String(id)}`); return {}; },
    importFolder: async (path: string) => { calls.push(`import:${path}`); return {}; },
  };
  registerLocalSkills({
    ipc: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); } },
    catalog, getWindow: () => window, getOrigin: () => "https://assistant.example",
    dialog: { showOpenDialog: async () => { calls.push("picker"); return picker ? picker() : selected; } },
    shell: { showItemInFolder: (path: string) => { calls.push(`show:${path}`); } },
  } as unknown as Options);
  return { frame, sender, calls,
    invoke: (name: string, event: unknown = { sender, senderFrame: frame }, ...args: unknown[]) => handlers.get(`desktop:skills-${name}`)!(event, ...args),
    close: () => { destroyed = true; }, cancel: () => { selected = { canceled: true, filePaths: [] }; },
    pause: (value: () => Promise<typeof selected>) => { picker = value; },
  };
}

test("local skill IPC accepts the configured top frame with a workspace hash", async () => {
  const f = fixture(); await f.invoke("list"); await f.invoke("read", undefined, "skill_id"); await f.invoke("reveal", undefined, "skill_id");
  assert.deepEqual(f.calls, ["list", "read:skill_id", "reveal", "show:/known/skill/SKILL.md"]);
});

test("every local skill handler rejects other windows, subframes, changed origins and closed windows before side effects", async () => {
  for (const name of ["list", "read", "reveal", "add-directory", "remove-directory", "import"]) {
    const f = fixture();
    for (const event of [{ sender: {}, senderFrame: f.frame }, { sender: f.sender, senderFrame: { url: f.frame.url } }]) await assert.rejects(async () => f.invoke(name, event, "id"), /Untrusted local skills window/);
    f.frame.url = "https://other.example/#skills";
    await assert.rejects(async () => f.invoke(name), /Untrusted local skills window/);
    f.frame.url = "data:text/html,untrusted";
    await assert.rejects(async () => f.invoke(name), /Untrusted local skills window/);
    f.frame.url = "https://assistant.example/#skills"; f.close();
    await assert.rejects(async () => f.invoke(name), /Untrusted local skills window/);
    assert.deepEqual(f.calls, []);
  }
});

test("directory and import operations use only the native picker selection and cancellation does not change files", async () => {
  const f = fixture(); await f.invoke("add-directory", undefined, "/renderer-controlled"); await f.invoke("import", undefined, "/renderer-controlled");
  assert.deepEqual(f.calls, ["picker", "add:/chosen/skills", "picker", "import:/chosen/skills"]);
  f.cancel(); assert.equal(await f.invoke("import"), null); assert.equal(f.calls.at(-1), "picker");
});

test("a picker cannot finish a write after navigation and concurrent writes are rejected", async () => {
  const f = fixture(); let release!: (value: { canceled: boolean; filePaths: string[] }) => void;
  f.pause(() => new Promise(resolve => { release = resolve; }));
  const first = f.invoke("import") as Promise<unknown>;
  await assert.rejects(async () => f.invoke("remove-directory", undefined, "root_id"), /已有本机技能操作/);
  f.frame.url = "https://other.example"; release({ canceled: false, filePaths: ["/chosen/skills"] });
  await assert.rejects(first, /Untrusted local skills window/);
  assert.deepEqual(f.calls, ["picker"]);
  f.frame.url = "https://assistant.example/#skills"; await f.invoke("remove-directory", undefined, "root_id");
  assert.equal(f.calls.at(-1), "remove:root_id");
});
