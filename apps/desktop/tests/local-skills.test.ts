import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LocalSkillCatalog } from "../dist/skills/catalog.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "local-skills-test-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  await mkdir(home);
  const stateFile = join(base, "state", "skills.json");
  return { base, home, stateFile, catalog: new LocalSkillCatalog({ home, stateFile }) };
}

async function skill(directory: string, content = "---\nname: example\ndescription: A useful skill\n---\n# Instructions\n") {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content);
}

async function missing(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("lists six default roots without treating absent roots as errors", async (t) => {
  const { catalog } = await fixture(t);
  const result = await catalog.list();
  assert.deepEqual(result.roots.map((root) => root.label), ["Agents", "Claude Code", "Codex", "DSH", "Pi", "OpenCode"]);
  assert.ok(result.roots.every((root) => !root.exists && !root.custom && /^root_[a-f0-9]{64}$/.test(root.id)));
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.warnings, []);
});

test("deduplicates real skill directories across tool links and retains every location", async (t) => {
  const { home, catalog } = await fixture(t);
  const directory = join(home, ".agents", "skills", "shared");
  await skill(directory);
  await mkdir(join(home, ".claude", "skills"), { recursive: true });
  await symlink(directory, join(home, ".claude", "skills", "alias"), "dir");
  const { skills, warnings } = await catalog.list();
  assert.equal(skills.length, 1);
  assert.match(skills[0].id, /^skill_[a-f0-9]{64}$/);
  assert.equal(skills[0].locations.length, 2);
  assert.deepEqual(skills[0].locations.map((location) => location.label), ["Agents", "Claude Code"]);
  assert.equal(await catalog.revealPath(skills[0].id), join(directory, "SKILL.md"));
  assert.deepEqual(warnings, []);
});

test("supports quoted scalars, escaped text and folded/literal descriptions without interpreting content", async (t) => {
  const { home, catalog } = await fixture(t);
  const root = join(home, ".agents", "skills");
  await skill(join(root, "single"), "---\nname: 'it''s-a-skill'\ndescription: >-\n  First line\n  second line\n\n  Next paragraph\n---\n$(touch should-never-run)\n");
  await skill(join(root, "double"), '---\nname: "double\\u002dquoted"\ndescription: "line\\nnext # quoted"\n---\nbody');
  await skill(join(root, "literal"), "---\nname: literal\ndescription: |\n  one\n  two\n---\nbody");
  await skill(join(root, "plain"), "---\nname: plain # comment\ndescription: https://example.test/#fragment # comment\n---\nbody");
  const { skills } = await catalog.list();
  assert.equal(skills.find((entry) => entry.name === "it's-a-skill")?.description, "First line second line\nNext paragraph");
  assert.equal(skills.find((entry) => entry.name === "double-quoted")?.description, "line\nnext # quoted");
  assert.equal(skills.find((entry) => entry.name === "literal")?.description, "one\ntwo\n");
  assert.equal(skills.find((entry) => entry.name === "plain")?.description, "https://example.test/#fragment");
  assert.ok(skills.every((entry) => !entry.issue));
});

test("reports unsupported, duplicated and truncated frontmatter explicitly", async (t) => {
  const { home, catalog } = await fixture(t);
  const root = join(home, ".agents", "skills");
  await skill(join(root, "complex"), "---\nname: [bad, sequence]\ndescription: {complex: value}\n---\nbody");
  await skill(join(root, "duplicate"), "---\nname: first\nname: second\ndescription: text\n---\nbody");
  await skill(join(root, "truncated"), `---\nname: truncated\ndescription: ${"x".repeat(17_000)}\n---\nbody`);
  const { skills, warnings } = await catalog.list();
  assert.equal(skills.length, 3);
  assert.ok(skills.every((entry) => entry.issue));
  assert.ok(warnings.some((warning) => /16\s*KiB|16384/.test(warning)));
});

test("bounds category depth, skips hidden/node_modules, and stops below a discovered skill", async (t) => {
  const { home, catalog } = await fixture(t);
  const root = join(home, ".agents", "skills");
  await skill(join(root, "a", "b", "c", "at-four"));
  await skill(join(root, "a", "b", "c", "d", "too-deep"));
  await skill(join(root, "stop"));
  await skill(join(root, "stop", "nested"));
  await skill(join(root, ".hidden"));
  await skill(join(root, "node_modules", "ignored"));
  const result = await catalog.list();
  assert.equal(result.skills.length, 2);
  assert.ok(result.warnings.some((warning) => /depth|深度/i.test(warning)));
});

test("rejects arbitrary IDs before path use and never follows SKILL.md symlinks or category loops", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const root = join(home, ".agents", "skills");
  await skill(join(base, "outside"));
  await mkdir(join(root, "linked-file"), { recursive: true });
  await symlink(join(base, "outside", "SKILL.md"), join(root, "linked-file", "SKILL.md"));
  await symlink(root, join(root, "loop"), "dir");
  const snapshot = await catalog.list();
  assert.equal(snapshot.skills.length, 0);
  assert.ok(snapshot.warnings.some((warning) => /symbolic|symlink|链接/i.test(warning)));
  for (const id of [null, {}, "../../outside/SKILL.md", join(base, "outside"), "skill_" + "0".repeat(64)]) {
    await assert.rejects(catalog.read(id));
    await assert.rejects(catalog.revealPath(id));
    await assert.rejects(catalog.removeRoot(id));
  }
  assert.match(await readFile(join(base, "outside", "SKILL.md"), "utf8"), /example/);
});

test("read refreshes metadata and content, validates the current file and does not cache a removed skill", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const directory = join(home, ".agents", "skills", "fresh");
  await skill(directory);
  const id = (await catalog.list()).skills[0].id;
  await writeFile(join(directory, "SKILL.md"), "---\nname: changed\ndescription: fresh\n---\nlatest body\n");
  const detail = await catalog.read(id);
  assert.equal(detail.name, "changed");
  assert.match(detail.content, /latest body/);
  assert.equal(detail.filePath, join(directory, "SKILL.md"));
  await skill(join(base, "outside"));
  await unlink(join(directory, "SKILL.md"));
  await symlink(join(base, "outside", "SKILL.md"), join(directory, "SKILL.md"));
  await assert.rejects(catalog.read(id));
  await assert.rejects(catalog.revealPath(id));
});

test("adds canonical custom roots, persists v1 state, and removes only configuration", async (t) => {
  const { base, home, catalog, stateFile } = await fixture(t);
  const directory = join(base, "custom");
  await skill(join(directory, "one"));
  const alias = join(base, "alias");
  await symlink(directory, alias, "dir");
  const added = await catalog.addRoot(directory);
  assert.equal(added.skills.length, 1);
  const root = added.roots.find((entry) => entry.custom)!;
  assert.equal(root.path, directory);
  assert.equal((await catalog.addRoot(alias)).roots.filter((entry) => entry.custom).length, 1);
  const disk = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(disk, { version: 1, roots: [directory] });
  const reloaded = new LocalSkillCatalog({ home, stateFile });
  assert.equal((await reloaded.list()).skills.length, 1);
  const removed = await reloaded.removeRoot(root.id);
  assert.equal(removed.skills.length, 0);
  assert.match(await readFile(join(directory, "one", "SKILL.md"), "utf8"), /example/);
  await assert.rejects(catalog.removeRoot(removed.roots[0].id));
  await assert.rejects(catalog.addRoot(join(base, "missing")));
});

test("reports corrupt/version-mismatched/linked state rather than overwriting it", async (t) => {
  const { base, home, stateFile } = await fixture(t);
  const directory = join(base, "custom");
  await skill(directory);
  await mkdir(join(base, "state"));
  for (const invalid of ["{broken", '{"version":2,"roots":[]}', '{"version":1,"roots":["relative"]}', '{"version":1,"roots":{}}']) {
    await writeFile(stateFile, invalid);
    const catalog = new LocalSkillCatalog({ home, stateFile });
    await assert.rejects(catalog.list(), /state|状态/i);
    await assert.rejects(catalog.addRoot(directory));
    assert.equal(await readFile(stateFile, "utf8"), invalid);
  }
  await unlink(stateFile);
  const target = join(base, "state-target.json");
  await writeFile(target, '{"version":1,"roots":[]}');
  await symlink(target, stateFile);
  await assert.rejects(new LocalSkillCatalog({ home, stateFile }).list());
  assert.equal(await readFile(target, "utf8"), '{"version":1,"roots":[]}');
});

test("file permissions surface explicitly for roots, state and skill reads", async (t) => {
  const { base, home, stateFile, catalog } = await fixture(t);
  const directory = join(base, "private");
  await skill(directory);
  await catalog.addRoot(directory);
  await chmod(directory, 0o000);
  try {
    await assert.rejects(catalog.list(), /EACCES|EPERM|permission|权限/i);
  } finally {
    await chmod(directory, 0o700);
  }
  await chmod(stateFile, 0o000);
  try {
    await assert.rejects(catalog.list(), /state|状态/i);
  } finally {
    await chmod(stateFile, 0o600);
  }
  await skill(join(home, ".agents", "skills", "unreadable"));
  await chmod(join(home, ".agents", "skills", "unreadable", "SKILL.md"), 0o000);
  const result = await catalog.list();
  assert.ok(result.warnings.some((warning) => /EACCES|EPERM|permission|权限/i.test(warning)));
});

test("imports one valid skill with ordinary assets and excludes repository/dependency/environment files", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const source = join(base, "source");
  await skill(source, "---\nname: imported-skill\ndescription: Imported description\n---\nbody\n");
  await mkdir(join(source, "assets"));
  await writeFile(join(source, "assets", "example.txt"), "asset payload");
  await mkdir(join(source, ".git"));
  await writeFile(join(source, ".git", "config"), "excluded");
  await mkdir(join(source, "node_modules"));
  await writeFile(join(source, "node_modules", "dependency.js"), "excluded");
  await writeFile(join(source, ".env"), "synthetic test fixture");
  await writeFile(join(source, ".env.local"), "synthetic test fixture");
  await writeFile(join(source, ".DS_Store"), "excluded");
  const result = await catalog.importFolder(source);
  const destination = join(home, ".agents", "skills", "imported-skill");
  assert.equal(result.snapshot.skills.find((entry) => entry.id === result.skillId)?.name, "imported-skill");
  assert.equal(await readFile(join(destination, "assets", "example.txt"), "utf8"), "asset payload");
  for (const excluded of [".git", "node_modules", ".env", ".env.local", ".DS_Store"]) await missing(join(destination, excluded));
  assert.equal((await readdir(join(home, ".agents", "skills"))).length, 1);
  await assert.rejects(catalog.importFolder(source), /exist|conflict|已存在|冲突/i);
  assert.equal(await readFile(join(destination, "assets", "example.txt"), "utf8"), "asset payload");
});

test("failed import rejects any symlink and leaves existing skills and external files untouched", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const source = join(base, "source");
  await skill(source, "---\nname: refused-link\ndescription: Description\n---\nbody");
  const outside = join(base, "outside.txt");
  await writeFile(outside, "keep me");
  await skill(join(home, ".agents", "skills", "existing"));
  await symlink(outside, join(source, "linked.txt"));
  await assert.rejects(catalog.importFolder(source), /symbolic|symlink|链接/i);
  await missing(join(home, ".agents", "skills", "refused-link"));
  assert.deepEqual(await readdir(join(home, ".agents", "skills")), ["existing"]);
  assert.equal(await readFile(outside, "utf8"), "keep me");
  await unlink(join(source, "linked.txt"));
  await symlink(outside, join(source, ".env.link"));
  await assert.rejects(catalog.importFolder(source), /symbolic|symlink|链接/i);
  await assert.rejects(catalog.importFolder(join(base, "missing")));
});

test("rejects invalid import metadata, oversized files and unsafe destination ancestors", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const source = join(base, "source");
  await skill(source, "---\nname: ../escape\ndescription: text\n---\nbody");
  await assert.rejects(catalog.importFolder(source), /slug|name|名称/i);
  await skill(source, "---\nname: safe\ndescription: [complex]\n---\nbody");
  await assert.rejects(catalog.importFolder(source), /metadata|元数据/i);
  await skill(source, "---\nname: safe\ndescription: text\n---\nbody");
  const asset = join(source, "huge.bin");
  await writeFile(asset, "");
  await truncate(asset, 11 * 1024 * 1024);
  await assert.rejects(catalog.importFolder(source), /size|limit|大小|上限/i);
  await unlink(asset);
  const external = join(base, "external");
  await mkdir(external);
  const unsafeHome = join(base, "unsafe-home");
  await mkdir(join(unsafeHome, ".agents"), { recursive: true });
  await symlink(external, join(unsafeHome, ".agents", "skills"), "dir");
  const unsafeCatalog = new LocalSkillCatalog({ home: unsafeHome, stateFile: join(base, "unsafe-state.json") });
  await assert.rejects(unsafeCatalog.importFolder(source), /symbolic|symlink|链接/i);
  assert.deepEqual(await readdir(external), []);
});

test("detail is capped at 1 MiB and invalid UTF-8 is not silently replaced", async (t) => {
  const { home, catalog } = await fixture(t);
  const root = join(home, ".agents", "skills");
  await skill(join(root, "huge"));
  await truncate(join(root, "huge", "SKILL.md"), 1024 * 1024 + 1);
  await mkdir(join(root, "invalid"), { recursive: true });
  await writeFile(join(root, "invalid", "SKILL.md"), Buffer.from([0xff, 0xfe, 0xff]));
  const snapshot = await catalog.list();
  assert.equal(snapshot.skills.length, 2);
  assert.ok(snapshot.skills.every((entry) => entry.issue));
  for (const entry of snapshot.skills) await assert.rejects(catalog.read(entry.id));
});

test("import never replaces an existing empty directory or destination symlink", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const source = join(base, "source");
  await skill(source, "---\nname: occupied\ndescription: text\n---\nbody");
  const destination = join(home, ".agents", "skills", "occupied");
  await mkdir(destination, { recursive: true });
  await assert.rejects(catalog.importFolder(source), /exist/i);
  assert.deepEqual(await readdir(destination), []);
  await rm(destination, { recursive: true });
  const outside = join(base, "outside");
  await mkdir(outside);
  await symlink(outside, destination, "dir");
  await assert.rejects(catalog.importFolder(source), /exist/i);
  assert.ok((await lstat(destination)).isSymbolicLink());
  assert.deepEqual(await readdir(outside), []);
});

test("serializes root mutations and continues after a failed operation", async (t) => {
  const { base, catalog } = await fixture(t);
  const first = join(base, "first");
  const second = join(base, "second");
  await skill(first);
  await skill(second);
  await Promise.all([catalog.addRoot(first), catalog.addRoot(second)]);
  assert.equal((await catalog.list()).roots.filter((root) => root.custom).length, 2);
  await assert.rejects(catalog.addRoot(join(base, "absent")));
  const snapshot = await catalog.list();
  await catalog.removeRoot(snapshot.roots.find((root) => root.path === first)!.id);
  assert.equal((await catalog.list()).roots.filter((root) => root.custom).length, 1);
});

test("warns when a configured root disappears and handles malformed default roots explicitly", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const root = join(base, "custom");
  await mkdir(root);
  await catalog.addRoot(root);
  await rm(root, { recursive: true });
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".codex", "skills"), "not a directory");
  const snapshot = await catalog.list();
  assert.ok(snapshot.warnings.some((warning) => /missing/i.test(warning)));
  assert.ok(snapshot.warnings.some((warning) => /not a directory/i.test(warning)));
  assert.equal(snapshot.roots.find((entry) => entry.custom)!.exists, false);
});

test("import bounds depth and entries and cleans only its own failed staging", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const deep = join(base, "deep");
  await skill(deep, "---\nname: deep\ndescription: text\n---\nbody");
  await mkdir(join(deep, ...Array.from({ length: 17 }, (_, index) => `level${index}`)), { recursive: true });
  await assert.rejects(catalog.importFolder(deep), /depth limit/i);
  const wide = join(base, "wide");
  await skill(wide, "---\nname: wide\ndescription: text\n---\nbody");
  for (let start = 0; start < 2001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 2001 - start) }, (_, offset) => writeFile(join(wide, `file-${start + offset}`), "")));
  }
  await assert.rejects(catalog.importFolder(wide), /entry limit/i);
  assert.deepEqual(await readdir(join(home, ".agents", "skills")), []);
});

test("import total bytes are bounded independently of per-file size", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const source = join(base, "source");
  await skill(source, "---\nname: total-limit\ndescription: text\n---\nbody");
  for (let index = 0; index < 6; index++) {
    const path = join(source, `asset-${index}`);
    await writeFile(path, "");
    await truncate(path, 9 * 1024 * 1024);
  }
  await assert.rejects(catalog.importFolder(source), /total size limit/i);
  assert.deepEqual(await readdir(join(home, ".agents", "skills")), []);
});

test("scanning bounds directory entries and reports partial results", async (t) => {
  const { home, catalog } = await fixture(t);
  const root = join(home, ".agents", "skills");
  await mkdir(root, { recursive: true });
  for (let start = 0; start < 10001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 10001 - start) }, (_, offset) => writeFile(join(root, `file-${start + offset}`), "")));
  }
  const result = await catalog.list();
  assert.ok(result.warnings.some((warning) => /entry limit 10000/i.test(warning)));
});

test("state size and custom root counts are bounded before scanning", async (t) => {
  const { base, stateFile, catalog } = await fixture(t);
  await mkdir(join(base, "state"));
  await writeFile(stateFile, " ".repeat(65537));
  await assert.rejects(catalog.list(), /state.*size.*limit/i);
  await writeFile(stateFile, JSON.stringify({ version: 1, roots: Array.from({ length: 65 }, (_, index) => join(base, `root-${index}`)) }));
  await assert.rejects(catalog.list(), /state.*Root count.*limit/i);
});

test("plain documents use the directory name, while unsupported metadata stays inspectable with an issue", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const root = join(home, ".agents", "skills");
  await skill(join(root, "plain-document"), "# Local instructions\nNever execute this content.\n");
  const malformed = [
    "---\nname: test\ndescription: first\n  continuation\n---\nbody",
    "---\nname: test\ndescription: \"bad\\qescape\"\n---\nbody",
    "---\nname: test\ndescription: 'unterminated\n---\nbody",
    "---\nname: test\ndescription: &alias text\n---\nbody",
    "---\nname: test\ndescription:\n  nested: value\n---\nbody",
    "---\nname:test\ndescription: text\n---\nbody",
  ];
  for (const [index, text] of malformed.entries()) await skill(join(root, `malformed-${index}`), text);
  const snapshot = await catalog.list();
  const plain = snapshot.skills.find((entry) => entry.name === "plain-document")!;
  assert.equal(plain.description, "");
  assert.equal(plain.issue, undefined);
  assert.ok(snapshot.skills.filter((entry) => entry.id !== plain.id).every((entry) => entry.issue));
  for (const entry of snapshot.skills) assert.match((await catalog.read(entry.id)).content, /body|Local instructions/);
  await assert.rejects(catalog.importFolder(join(root, "plain-document")), /metadata/i);
  await assert.rejects(catalog.addRoot("relative"));
  assert.throws(() => new LocalSkillCatalog({ home: "relative", stateFile: join(base, "state.json") }));
});

test("a default category symlink is skipped, but its real directory can be explicitly added", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const root = join(base, "shared-category");
  await skill(join(root, "one"));
  await mkdir(join(home, ".claude"));
  await symlink(root, join(home, ".claude", "skills"), "dir");
  const before = await catalog.list();
  assert.equal(before.skills.length, 0);
  assert.ok(before.warnings.some((warning) => /symlink/i.test(warning)));
  const added = await catalog.addRoot(root);
  assert.equal(added.skills.length, 1);
  assert.ok(added.roots.find((entry) => entry.path === root)?.custom);
});

test("linked plain-document skills have consistent names and preserve a UTF-8 BOM", async (t) => {
  const { base, home, catalog } = await fixture(t);
  const source = join(base, "canonical-name");
  const content = "\uFEFF# Instructions\n";
  await skill(source, content);
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await symlink(source, join(home, ".codex", "skills", "alias-name"), "dir");
  const entry = (await catalog.list()).skills[0];
  const detail = await catalog.read(entry.id);
  assert.equal(entry.name, "canonical-name");
  assert.equal(detail.name, entry.name);
  assert.equal(detail.content, content);
});
