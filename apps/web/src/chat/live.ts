import type { BrowserLive, RunningTool } from "../types.js";

// 解析 live 状态
function extractLiveInfo(live: BrowserLive | undefined) {
    if (!live)
        return null;
    let text = '';
    let thinking = '';
    const runningTools: RunningTool[] = [];
    if (live.generation && live.generation.message) {
        const msg = live.generation.message;
        const contents = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
        for (const item of contents) {
            if (typeof item === 'string') {
                text += item;
            }
            else if (item && typeof item === 'object') {
                if (item.type === 'text' && item.text) {
                    text += item.text;
                }
                else if (item.type === 'thinking' && item.thinking) {
                    thinking += item.thinking;
                }
                else if (item.type === 'toolCall') {
                    runningTools.push({
                        name: item.name || '工具调用',
                        args: item.arguments || item.args,
                        status: 'running'
                    });
                }
            }
        }
    }
    if (!text && typeof live.text === 'string')
        text = live.text;
    if (!text && typeof live.generation?.text === 'string')
        text = live.generation.text;
    if (!text && typeof live.stream === 'string')
        text = live.stream;
    if (Array.isArray(live.tools)) {
        for (const slot of live.tools) {
            runningTools.push({
                name: slot.name || '工具',
                callId: slot.callId,
                status: slot.status || 'running',
                output: slot.output || '',
                args: slot.args,
                details: slot.details
            });
        }
    }
    return {
        text: text.trim(),
        thinking: thinking.trim(),
        runningTools
    };
}
export { extractLiveInfo };
