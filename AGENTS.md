# 协作规则（给参与本仓库的所有 Agent / CLI）

- 当前功能与运行方式以 `README.md` 为准，设计规格参照 `SPEC.md`，v3 已交付 API、限制与第二阶段计划参照 `docs/V3_PLAN.md`。`SPEC.md` 中 v1/v2 段落含历史设计记录；有冲突时先核对实际代码与固定版本 API。
- API 以 `node_modules/@earendil-works/*/dist/**/*.d.ts` 和 `node_modules/@earendil-works/pi-durable/README.md` 为准，不凭记忆编 API。
- 只改明确要求的文件；修改 `SPEC.md`、`AGENTS.md`、`package.json` 或引入依赖需要有用户/项目负责人明确要求，默认保持原生 ESM、无前端构建步骤。
- 不读取、不打印任何 `.env` 和密钥；允许访问用户明确指定的远程主机，仅限本次部署与验证目标；不执行 git commit / push（由编排者统一提交）。
- 写完运行 `npm run check`、`npm test` 与适用的本地验证；交付时列出：改了哪些文件、怎么验证的、哪些没验证，不把 CI 通过等同于生产部署验证。
