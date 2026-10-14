package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/lawrencewzen/wx-bot/internal/ilink"
)

func TestQuoteText(t *testing.T) {
	text := func(s string) *ilink.MessageItem {
		return &ilink.MessageItem{Type: ilink.ItemTypeText, TextItem: &ilink.TextItem{Text: s}}
	}
	cases := []struct {
		name string
		ref  *ilink.RefMessage
		want string
	}{
		{"nil", nil, ""},
		{"empty", &ilink.RefMessage{}, ""},
		{"title only", &ilink.RefMessage{Title: "目标聊天：Levi Qian"}, "[引用：目标聊天：Levi Qian]"},
		{"item only", &ilink.RefMessage{MessageItem: text("好的")}, "[引用：好的]"},
		{"title and item", &ilink.RefMessage{Title: "摘要", MessageItem: text("原文")}, "[引用：摘要 | 原文]"},
		{"same title and item", &ilink.RefMessage{Title: "好的", MessageItem: text("好的")}, "[引用：好的]"},
		{"image", &ilink.RefMessage{MessageItem: &ilink.MessageItem{Type: ilink.ItemTypeImage}}, "[引用：[图片]]"},
	}
	for _, c := range cases {
		if got := quoteText(c.ref); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
	long := quoteText(&ilink.RefMessage{Title: strings.Repeat("长", 800)})
	if n := len([]rune(long)); n > maxQuoteRunes+10 {
		t.Errorf("引用没有被截断：%d 个字符", n)
	}
}

// 上游的 MessageItem 没有 ref_msg 字段，解码时会丢掉引用；这里确认补丁后能保留。
func TestMessageItemKeepsRefMsg(t *testing.T) {
	var item ilink.MessageItem
	raw := `{"type":1,"text_item":{"text":"帮我回复好的"},"ref_msg":{"title":"草稿","message_item":{"type":1,"text_item":{"text":"目标聊天：Levi Qian"}}}}`
	if err := json.Unmarshal([]byte(raw), &item); err != nil {
		t.Fatal(err)
	}
	if got := quoteText(item.RefMsg); got != "[引用：草稿 | 目标聊天：Levi Qian]" {
		t.Fatalf("引用解码后丢失：%q", got)
	}
}

// 带引用的文本消息：Webhook 的 text 里，引用在前、正文在后。
func TestBuildPayloadPrependsQuote(t *testing.T) {
	p := &Poller{
		Name:   "primary",
		Client: ilink.NewClient(&ilink.Session{BotToken: "tok", BaseURL: "http://127.0.0.1:1", BotID: "bot@im.bot", UserID: "wxid_owner"}),
	}
	payload, err := p.buildPayload(context.Background(), ilink.IncomingMessage{
		MessageID:  1,
		FromUserID: "wxid_test",
		ItemList: []ilink.MessageItem{{
			Type:     ilink.ItemTypeText,
			TextItem: &ilink.TextItem{Text: "帮我回复好的"},
			RefMsg:   &ilink.RefMessage{Title: "目标聊天：Levi Qian"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if payload.Text != "[引用：目标聊天：Levi Qian]\n帮我回复好的" {
		t.Fatalf("text = %q", payload.Text)
	}
}
