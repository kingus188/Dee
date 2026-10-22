import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { root } from "./workspaces.js";

export function buildMacLauncher(bundle: string) {
  const info = join(bundle, "Contents/Info.plist");
  const field = (name: string) => execFileSync("/usr/bin/plutil", ["-extract", name, "raw", "-o", "-", info], { encoding: "utf8" }).trim();
  const executable = join(bundle, "Contents/MacOS", field("CFBundleExecutable"));
  const uuid = () => execFileSync("xcrun", ["dwarfdump", "--uuid", executable], { encoding: "utf8" }).match(/UUID: ([A-F0-9-]+)/)?.[1];
  const original = uuid();
  if (!original) throw new Error("Electron launcher is missing its build UUID");
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  execFileSync("xcrun", ["clang++", "-std=c++20", "-arch", arch,
    "-mmacosx-version-min=" + field("LSMinimumSystemVersion"),
    "-F" + join(bundle, "Contents/Frameworks"), "-framework", "Electron Framework",
    "-Wl,-rpath,@executable_path/../Frameworks", join(root, "apps/desktop/native/main.cc"), "-o", executable,
  ], { stdio: "inherit", timeout: 30_000 });
  const built = uuid();
  if (!built || built === original) throw new Error("Desktop launcher must have its own build UUID");
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit", timeout: 30_000 });
}
