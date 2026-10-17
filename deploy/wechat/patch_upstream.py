"""固定上游 commit 的最小源代码补丁：可靠推进游标 + 二维码 POST。
严格匹配源码片段；上游变化时构建必须失败，禁止静默生成不兼容镜像。
"""
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])


def replace_once(path, before, after):
    file = root / path
    src = file.read_text()
    count = src.count(before)
    if count != 1:
        raise SystemExit(f"{path}: expected one patch location, found {count}")
    file.write_text(src.replace(before, after, 1))


replace_once("internal/ilink/login.go",
    'http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)',
    'http.NewRequestWithContext(ctx, http.MethodPost, reqURL, strings.NewReader(`{"local_token_list":[]}`))')
replace_once("internal/ilink/login.go",
    'AddAppHeaders(req, "")\n\n\tresp, err := l.http().Do(req)',
    'AddAppHeaders(req, "")\n\treq.Header.Set("AuthorizationType", "ilink_bot_token")\n\treq.Header.Set("Content-Type", "application/json")\n\n\tresp, err := l.http().Do(req)')

# 只有入站 Webhook 获得成功响应，才推进 getupdates cursor。
# 若请求失败，重放批次由 Pi Durable 通过 requestId 去重。
replace_once("internal/bridge/poller.go",
    '''\t\tif resp.GetUpdatesBuf != "" {
\t\t\tcursor = resp.GetUpdatesBuf
\t\t\tif err := p.Store.SaveCursor(cursor); err != nil {
\t\t\t\tlog.Error("save cursor", "err", err)
\t\t\t}
\t\t}

''', '')
replace_once("internal/bridge/poller.go",
    '''\t\tfor _, msg := range resp.Msgs {
\t\t\tp.handleMessage(ctx, msg)
\t\t}
''',
    '''\t\tdelivered := true
\t\tfor _, msg := range resp.Msgs {
\t\t\tif err := p.handleMessage(ctx, msg); err != nil {
\t\t\t\tlog.Error("webhook delivery failed; cursor unchanged", "err", err)
\t\t\t\tdelivered = false
\t\t\t\tbreak
\t\t\t}
\t\t}
\t\tif !delivered {
\t\t\tselect {
\t\t\tcase <-time.After(p.retry()):
\t\t\tcase <-ctx.Done():
\t\t\t\treturn
\t\t\t}
\t\t\tcontinue
\t\t}
\t\tif resp.GetUpdatesBuf != "" {
\t\t\tif err := p.Store.SaveCursor(resp.GetUpdatesBuf); err != nil {
\t\t\t\tlog.Error("save cursor", "err", err)
\t\t\t\tcontinue
\t\t\t}
\t\t\tcursor = resp.GetUpdatesBuf
\t\t}
''')
replace_once("internal/bridge/poller.go",
    '''\t\tdelivered := true
''',
    '''\t\tif resp.Ret != 0 || resp.ErrCode != 0 {
\t\t\tlog.Warn("iLink business error; cursor unchanged", "ret", resp.Ret, "errcode", resp.ErrCode)
\t\t\tselect {
\t\t\tcase <-time.After(p.retry()):
\t\t\tcase <-ctx.Done():
\t\t\t\treturn
\t\t\t}
\t\t\tcontinue
\t\t}
\t\tdelivered := true
''')
replace_once("internal/bridge/poller.go",
    'func (p *Poller) handleMessage(ctx context.Context, msg ilink.IncomingMessage) {',
    'func (p *Poller) handleMessage(ctx context.Context, msg ilink.IncomingMessage) error {')
before = '''\tif !allowed {
\t\tlog.Info("unallowed sender")
\t\tif !p.ForwardUnallowed {
\t\t\treturn
\t\t}
\t}
'''
after = before.replace('\t\t\treturn\n', '\t\t\treturn nil\n')
replace_once("internal/bridge/poller.go", before, after)
replace_once("internal/bridge/poller.go",
    '''\tpayload, err := p.buildPayload(ctx, msg)
\tif err != nil {
\t\tlog.Error("build payload", "err", err)
\t\treturn
\t}

\tif p.Webhook == nil || p.Webhook.Webhook.URL == "" {
\t\tlog.Warn("webhook url empty, dropping message")
\t\treturn
\t}
\tif err := p.Webhook.Post(ctx, payload); err != nil {
\t\tlog.Error("webhook post", "err", err)
\t}
''',
    '''\tpayload, err := p.buildPayload(ctx, msg)
\tif err != nil {
\t\treturn err
\t}
\tif p.Webhook == nil || p.Webhook.Webhook.URL == "" {
\t\treturn fmt.Errorf("webhook url missing")
\t}
\treturn p.Webhook.Post(ctx, payload)
''')
# 重定向/中断后不推进游标；下次重放交由 Durable 幂等提交。
replace_once("internal/bridge/poller.go",
    '''\t\tif resp.GetUpdatesBuf != "" {
\t\t\tif err := p.Store.SaveCursor(resp.GetUpdatesBuf); err != nil {''',
    '''\t\tif ctx.Err() != nil {
\t\t\treturn
\t\t}
\t\tif resp.GetUpdatesBuf != "" {
\t\t\tif err := p.Store.SaveCursor(resp.GetUpdatesBuf); err != nil {''')

# 原上游的两个测试只等到了 webhook 回调就退出，没有等 poller goroutine 停止。
# 推迟游标提交以后这会和 t.TempDir 清理竞争；仅补等待，不改变任何断言。
test_file = root / "internal/bridge/poller_test.go"
test_source = test_file.read_text()
for name in ("TestPollerTwoImagesDistinctFiles", "TestPollerHasContextTokenFromCache"):
    start = test_source.index("func " + name + "(")
    next_start = test_source.find("\nfunc ", start + 1)
    end = len(test_source) if next_start < 0 else next_start
    part = test_source[start:end]
    if part.count("go p.Run(ctx)") != 1 or "\tcancel()\n" not in part:
        raise SystemExit(f"{name}: upstream test layout changed")
    part = part.replace("go p.Run(ctx)",
        "done := make(chan struct{})\n\tgo func() { p.Run(ctx); close(done) }()", 1)
    part = part.replace("\tcancel()\n", "\tcancel()\n\t<-done\n", 1)
    test_source = test_source[:start] + part + test_source[end:]
test_file.write_text(test_source)

# 用户在微信里"引用回复"时，iLink 会在消息条目里带 ref_msg（被引用消息的摘要和/或内容）。
# 上游的 MessageItem 没有这个字段，引用内容在 JSON 解码时被丢弃，下游 Agent 不知道用户回复的是哪一条。
replace_once("internal/ilink/types.go",
    '\tVideoItem *VideoItem `json:"video_item,omitempty"`\n}',
    '\tVideoItem *VideoItem `json:"video_item,omitempty"`\n\tRefMsg    *RefMessage `json:"ref_msg,omitempty"`\n}\n\n'
    '// RefMessage 是用户引用的那条消息：Title 是摘要，MessageItem 是内容（新版客户端可能只有摘要）。\n'
    'type RefMessage struct {\n\tTitle       string       `json:"title,omitempty"`\n\tMessageItem *MessageItem `json:"message_item,omitempty"`\n}')
# 引用单独走 payload 的 quote 字段，绝不拼进 text：text 必须只有用户自己打的字，
# 下游才能把发送授权只认在用户原话上，而不会被引用里的「确认发送」骗过去。
replace_once("internal/bridge/webhook.go",
    '\tReplyHint       string     `json:"reply_hint"`\n}',
    '\tReplyHint       string     `json:"reply_hint"`\n'
    '\t// Quote 是用户"引用回复"时被引用的那条消息，来自第三方，不是用户原话。\n'
    '\tQuote string `json:"quote,omitempty"`\n}')
replace_once("internal/bridge/poller.go",
    '\tvar texts []string\n',
    '\tvar texts []string\n\tvar quote string\n')
replace_once("internal/bridge/poller.go",
    '\t\t\tif item.TextItem != nil && item.TextItem.Text != "" {\n\t\t\t\ttexts = append(texts, item.TextItem.Text)\n\t\t\t}',
    '\t\t\tif item.TextItem != nil && item.TextItem.Text != "" {\n'
    '\t\t\t\tif q := quoteText(item.RefMsg); q != "" && quote == "" {\n'
    '\t\t\t\t\tp.log().Info("inbound quote", "has_title", item.RefMsg.Title != "", "has_item", item.RefMsg.MessageItem != nil)\n'
    '\t\t\t\t\tquote = q\n'
    '\t\t\t\t}\n'
    '\t\t\t\ttexts = append(texts, item.TextItem.Text)\n'
    '\t\t\t}')
replace_once("internal/bridge/poller.go",
    '\t\tReplyHint:       fmt.Sprintf("wx-bot send --binding %s --to %s --text \'...\'", p.Name, msg.FromUserID),\n',
    '\t\tReplyHint:       fmt.Sprintf("wx-bot send --binding %s --to %s --text \'...\'", p.Name, msg.FromUserID),\n'
    '\t\tQuote:           quote,\n')
# 补丁引入的字段改变了结构体对齐，交给 gofmt 统一格式。
for formatted in ("internal/ilink/types.go", "internal/bridge/webhook.go", "internal/bridge/poller.go"):
    subprocess.run(["gofmt", "-w", str(root / formatted)], check=True)
# 引用拼接函数和它的测试放在 extra/，避免在补丁脚本里内嵌 Go 源码。
extra = Path(__file__).resolve().parent / "extra"
for source in sorted(extra.rglob("*.go")):
    target = root / "internal" / source.relative_to(extra)
    target.write_text(source.read_text())

print("wx-bot compatibility and cursor patch applied")
