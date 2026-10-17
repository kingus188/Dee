package bridge

import (
	"strings"

	"github.com/lawrencewzen/wx-bot/internal/ilink"
)

const maxQuoteRunes = 500

// quoteText 把用户引用的消息拼成「摘要 | 内容」。它只进 Payload 的 quote 字段，
// 绝不拼进 text：下游要把用户原话和第三方引用分开，引用不能充当指令或授权。
func quoteText(ref *ilink.RefMessage) string {
	if ref == nil {
		return ""
	}
	var parts []string
	title := strings.TrimSpace(ref.Title)
	if title != "" {
		parts = append(parts, title)
	}
	if body := quoteBody(ref.MessageItem); body != "" && body != title {
		parts = append(parts, body)
	}
	if len(parts) == 0 {
		return ""
	}
	quote := strings.Join(parts, " | ")
	if runes := []rune(quote); len(runes) > maxQuoteRunes {
		quote = string(runes[:maxQuoteRunes]) + "…"
	}
	return quote
}

func quoteBody(item *ilink.MessageItem) string {
	if item == nil {
		return ""
	}
	switch item.Type {
	case ilink.ItemTypeText:
		if item.TextItem != nil {
			return strings.TrimSpace(item.TextItem.Text)
		}
	case ilink.ItemTypeVoice:
		if item.VoiceItem != nil && strings.TrimSpace(item.VoiceItem.Text) != "" {
			return strings.TrimSpace(item.VoiceItem.Text)
		}
		return "[语音]"
	case ilink.ItemTypeImage:
		return "[图片]"
	case ilink.ItemTypeFile:
		return "[文件]"
	case ilink.ItemTypeVideo:
		return "[视频]"
	}
	return ""
}
