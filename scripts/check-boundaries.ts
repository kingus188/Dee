import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import ts from "typescript";
import { root, workspacePaths } from "./workspaces.js";

type Graph = Map<string, Set<string>>;
function findCycle(graph: Graph): string[] | undefined {
  const complete = new Set<string>();
  const path: string[] = [];
  function visit(node: string): string[] | undefined {
    const at = path.indexOf(node);
    if (at !== -1) return [...path.slice(at), node];
    if (complete.has(node)) return;
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    complete.add(node);
  }
  for (const node of graph.keys()) { const cycle = visit(node); if (cycle) return cycle; }
}
assert.equal(findCycle(new Map([["a", new Set(["b"])], ["b", new Set()]])), undefined);
assert.deepEqual(findCycle(new Map([["a", new Set(["b"])], ["b", new Set(["a"])]])), ["a", "b", "a"]);

const packageGraph: Graph = new Map(), fileGraph: Graph = new Map();
const errors: string[] = [];
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(resolve(dir, e.name)) : /\.tsx?$/.test(e.name) ? [resolve(dir, e.name)] : []))).flat();
}
for (const workspace of workspacePaths()) {
  const folder = resolve(root, workspace), src = resolve(folder, "src");
  const pkg = JSON.parse(await readFile(resolve(folder, "package.json"), "utf8")) as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const dependencies = new Set(Object.keys(pkg.dependencies ?? {}));
  const allowed: Record<string, string[]> = { "packages/contracts": [], "packages/runtime": [], "packages/features": ["@assistant/runtime"], "packages/channel-wechat": ["@assistant/runtime"], "apps/web": ["@assistant/contracts"] };
  for (const dependency of dependencies) {
    if (workspace === "packages/contracts" || (dependency.startsWith("@assistant/") && allowed[workspace] && !allowed[workspace].includes(dependency))) errors.push(pkg.name + ": 禁止依赖 " + dependency);
  }
  packageGraph.set(pkg.name, new Set([...dependencies].filter(n => n.startsWith("@assistant/"))));
  const sourceFiles = new Set(await files(src));
  for (const file of sourceFiles) {
    const code = await readFile(file, "utf8"), parsed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const edges = new Set<string>(); fileGraph.set(file, edges);
    const fail = (message: string) => errors.push(relative(root, file) + ": " + message);
    function check(specifier: string, typeOnly: boolean) {
      if (specifier.startsWith(".")) {
        let target = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
        if (!sourceFiles.has(target)) target = target.replace(/\.ts$/, ".tsx");
        const rel = relative(src, target);
        if (rel.startsWith("..") || isAbsolute(rel)) fail("禁止跨包相对路径 " + specifier);
        edges.add(target);
      } else {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (specifier.startsWith("node:")) {
          if (workspace === "apps/web" || workspace === "packages/contracts") fail("浏览器协议边界禁止 Node 模块");
        } else if (!dependencies.has(name) && !(workspace === "apps/desktop" && name === "electron" && pkg.devDependencies?.electron)) fail("未声明依赖 " + specifier);
        if (name.startsWith("@assistant/") && specifier !== name) fail("只能使用包公开入口 " + specifier);
        if (workspace === "apps/web" && !["react", "react-dom"].includes(name) && (name !== "@assistant/contracts" || !typeOnly)) fail("网页仅允许 React 和协议类型依赖");
      }
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text, node.importClause?.isTypeOnly === true);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text, node.isTypeOnly);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text, false);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) check(node.argument.literal.text, true);
      if (ts.isPropertyAccessExpression(node) && node.getText(parsed) === "process.env" && !["apps/server/src/main.ts", "apps/server/src/config.ts", "apps/desktop/src/main.ts"].includes(relative(root, file))) fail("环境变量只能由应用入口读取");
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
}
for (const [name, graph] of [["包", packageGraph], ["源码", fileGraph]] as const) {
  const cycle = findCycle(graph); if (cycle) errors.push(name + "循环依赖：" + cycle.map(n => isAbsolute(n) ? relative(root, n) : n).join(" -> "));
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(`依赖边界检查通过：${packageGraph.size} 个工作区、${fileGraph.size} 个源码模块，无循环依赖。`);
