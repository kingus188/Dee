
function formatFileSize(bytes: number | null | undefined) {
    if (bytes === null || bytes === undefined || isNaN(bytes))
        return '0 B';
    if (bytes < 1024)
        return bytes + ' B';
    if (bytes < 1024 * 1024)
        return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// --- 工具函数 ---
function escapeHtml(str: unknown) {
    if (str === null || str === undefined)
        return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function generateUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function formatTime(timestamp: string | number) {
    if (!timestamp)
        return '-';
    const d = new Date(timestamp);
    if (isNaN(d.getTime()))
        return String(timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatShortTime(timestamp: string | number) {
    if (!timestamp)
        return '';
    const d = new Date(timestamp);
    if (isNaN(d.getTime()))
        return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number) {
    if (ms <= 0)
        return '0 秒';
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins > 0) {
        return `${mins} 分 ${secs} 秒`;
    }
    return `${secs} 秒`;
}

function formatToolArgs(args: unknown) {
    if (!args)
        return '(无参数)';
    if (typeof args === 'string')
        return args;
    if (typeof args !== 'object')
        return String(args);
    const entries = Object.entries(args);
    if (entries.length === 0)
        return '(无参数)';
    return entries
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' · ');
}

function getLastNonEmptyLine(output: unknown) {
    if (!output || typeof output !== 'string')
        return '';
    const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : '';
}

export { escapeHtml, formatFileSize, formatTime, getLastNonEmptyLine, formatDuration, formatToolArgs, generateUuid };
