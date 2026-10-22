// Copyright (c) 2022 Slack Technologies, Inc. MIT license.
// Adapted from Electron macOS entry and stdio initialization; frameworks/helpers stay unchanged.
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <sys/stat.h>
#include <unistd.h>
extern "C" int ElectronMain(int, char**);
extern "C" int ElectronInitializeICUandStartNode(int, char**);
namespace electron::fuses { bool IsRunAsNodeEnabled(); }
// Keep the product identity in the linked image so its UUID differs from stock Electron.
__attribute__((used)) static const char product[] = "com.pi-durable.assistant";
int main(int argc, char** argv) {
  struct stat st;
  if (fstat(0, &st) < 0 && errno == EBADF) (void)freopen("/dev/null", "r", stdin);
  if (fstat(1, &st) < 0 && errno == EBADF) (void)freopen("/dev/null", "w", stdout);
  if (fstat(2, &st) < 0 && errno == EBADF) (void)freopen("/dev/null", "w", stderr);
  const char* node = getenv("ELECTRON_RUN_AS_NODE");
  if (electron::fuses::IsRunAsNodeEnabled() && node && *node) return ElectronInitializeICUandStartNode(argc, argv);
  return ElectronMain(argc, argv);
}
