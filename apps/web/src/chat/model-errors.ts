export function describeModelError(error: string): { title: string; description: string; settings?: boolean } {
  if (/insufficient.?quota|quota.*exceed|billing|credit.*exhaust|余额不足|额度不足/i.test(error)) return { title: "模型服务的可用额度不足", description: "消息已保留，请检查服务额度或切换可用模型后再试。", settings: true };
  if (/unauthoriz|invalid.?api.?key|incorrect.?api.?key|authentication|\b40[13]\b/i.test(error)) return { title: "模型服务暂未连接好", description: "消息已保留，请联系服务器管理员检查模型连接，或选择其他可用模型。", settings: true };
  if (/overload|over.?capacity|server.*busy|\b503\b/i.test(error)) return { title: "服务有点忙，请稍后再试", description: "小 D 暂时没能完成回复。你的消息已保留，稍等片刻后可以重试。" };
  if (/rate.?limit|too many request|\b429\b/i.test(error)) return { title: "请求有点频繁，稍等一下", description: "消息已保留，等一会儿再试就好。" };
  if (/context.?length|maximum context|too many tokens|prompt.*too long/i.test(error)) return { title: "这段对话有点长了", description: "可以精简问题，或开启新对话后再试。原有记录会保留。" };
  if (/timeout|timed.?out|ETIMEDOUT|fetch failed|ECONN|network/i.test(error)) return { title: "这次连接没有完成", description: "消息已保留，请检查网络，稍后再试。" };
  return { title: "这次回复没有完成", description: "你的消息已保留，可以稍后重试。若持续出现，请检查模型服务。" };
}
