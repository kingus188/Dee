# Open Markdown Lane editor kernel

Source: https://github.com/kingus188/open-markdown-lane
Commit: 3dd6fe408ab9cbf0d08cd47f9f5a14404bac9eb8
Version: 0.24.4
License: MIT (see LICENSE).

Vendored RichEditor and its transitive editor modules; desktop host, filesystem, AI and application shell are excluded. Original TypeScript is bundled by scripts/build.ts; the Dee adapter is in src/editor/lane. Local adaptations: Chinese-only string formatting, KaTeX math rendering, web-only media sanitization, preserving original line endings at the adapter boundary, and read-only guards for task checkboxes and emoji suggestions. Dee also releases active CodeMirror fence views before externally replacing their Markdown model. The host adapter defers controlled updates during composition and invalidates stale asynchronous image insertion.
