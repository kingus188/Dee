import type { PendingAttachment } from "../types.js";
import { showToast } from "../ui/toast.js";
import { escapeHtml, formatFileSize } from "../ui/format.js";
import type { AppState } from "../state.js";

export function createChatAttachments(state: AppState) {
// --- 附件校验与格式化常量 ---
const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
    'cs', 'rb', 'php', 'sh', 'zsh', 'bash', 'sql', 'toml', 'ini', 'conf', 'log', 'srt', 'vtt'
]);

const SUPPORTED_IMAGE_MIMES = new Set([
    'image/png', 'image/jpeg', 'image/webp', 'image/gif'
]);

function cleanAttachmentName(raw: unknown) {
    const name = String(raw ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"<>]/g, '').trim().slice(0, 100);
    return name || 'attachment';
}

function getFileExtension(name: string) {
    return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, len)));
    }
    return btoa(binary);
}

async function processAttachmentFile(file: File): Promise<PendingAttachment | {
    error: string;
}> {
    const rawName = cleanAttachmentName(file.name);
    const ext = getFileExtension(rawName);
    const mime = String(file.type || '').toLowerCase().split(';')[0].trim();
    // 明确拒绝 SVG
    if (mime === 'image/svg+xml' || ext === 'svg') {
        return { error: '暂不支持这种文件，目前支持图片和文本类文件' };
    }
    const isImage = SUPPORTED_IMAGE_MIMES.has(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
    const isText = (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext));
    if (!isImage && !isText) {
        return { error: '暂不支持这种文件，目前支持图片和文本类文件' };
    }
    if (isImage) {
        const isGif = mime === 'image/gif' || ext === 'gif';
        if (isGif) {
            if (file.size > 5 * 1024 * 1024) {
                return { error: `GIF 动图「${rawName}」超过 5MB` };
            }
            const buffer = await file.arrayBuffer();
            const base64 = arrayBufferToBase64(buffer);
            return {
                kind: 'image',
                name: rawName,
                mimeType: 'image/gif',
                size: file.size,
                data: base64,
                previewUrl: URL.createObjectURL(file),
            };
        }
        // JPEG / PNG / WebP：检查长边和文件大小判断是否需要压缩
        let img: HTMLImageElement;
        let objUrl: string | undefined;
        try {
            objUrl = URL.createObjectURL(file);
            img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error(`图片「${rawName}」加载失败`));
                img.src = objUrl!;
            });
        }
        catch (e) {
            if (objUrl)
                URL.revokeObjectURL(objUrl);
            return { error: (e instanceof Error ? e.message : String(e)) };
        }
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        const maxDim = Math.max(width, height);
        const needCompress = maxDim > 2048 || file.size > 1.5 * 1024 * 1024;
        if (needCompress) {
            let targetWidth = width;
            let targetHeight = height;
            if (maxDim > 2048) {
                const scale = 2048 / maxDim;
                targetWidth = Math.round(width * scale);
                targetHeight = Math.round(height * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, targetWidth, targetHeight);
            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
            URL.revokeObjectURL(objUrl);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            const base64 = dataUrl.split(',')[1];
            const byteSize = Math.round((base64.length * 3) / 4);
            const newName = rawName.replace(/\.[^.]+$/, '') + '.jpg';
            if (byteSize > 5 * 1024 * 1024) {
                return { error: `图片「${newName}」超过 5MB` };
            }
            return {
                kind: 'image',
                name: newName,
                mimeType: 'image/jpeg',
                size: byteSize,
                data: base64,
                previewUrl: dataUrl,
            };
        }
        else {
            if (file.size > 5 * 1024 * 1024) {
                URL.revokeObjectURL(objUrl);
                return { error: `图片「${rawName}」超过 5MB` };
            }
            const buffer = await file.arrayBuffer();
            const base64 = arrayBufferToBase64(buffer);
            const targetMime = mime || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
            return {
                kind: 'image',
                name: rawName,
                mimeType: targetMime,
                size: file.size,
                data: base64,
                previewUrl: objUrl,
            };
        }
    }
    // 文本类文件
    if (file.size > 200 * 1024) {
        return { error: `文本文件「${rawName}」超过 200KB` };
    }
    const buffer = await file.arrayBuffer();
    let textContent;
    try {
        textContent = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    }
    catch {
        return { error: `「${rawName}」不是 UTF-8 文本` };
    }
    if (textContent.includes('\u0000')) {
        return { error: `「${rawName}」不是文本文件` };
    }
    const base64 = arrayBufferToBase64(buffer);
    const targetMime = mime || 'text/plain';
    return {
        kind: 'text',
        name: rawName,
        mimeType: targetMime,
        size: file.size,
        data: base64,
    };
}

async function handleFilesSelected(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (!files.length)
        return;
    if (state.pendingAttachments.length + files.length > 5) {
        showToast('一次最多上传 5 个附件', 'warning');
        return;
    }
    let currentTotalBytes = state.pendingAttachments.reduce((sum, a) => sum + (a.size || 0), 0);
    for (const file of files) {
        if (state.pendingAttachments.length >= 5) {
            showToast('一次最多上传 5 个附件', 'warning');
            break;
        }
        try {
            const res = await processAttachmentFile(file);
            if ('error' in res) {
                showToast(res.error, 'warning');
                continue;
            }
            if (currentTotalBytes + res.size > 10 * 1024 * 1024) {
                showToast('附件总大小不能超过 10MB', 'warning');
                continue;
            }
            currentTotalBytes += res.size;
            state.pendingAttachments.push(res);
        }
        catch (err) {
            showToast((err instanceof Error ? err.message : String(err)) || '处理文件失败', 'warning');
        }
    }
    renderPendingAttachments();
    updateSendButtonState();
}

function removePendingAttachment(index: number) {
    if (index >= 0 && index < state.pendingAttachments.length) {
        const item = state.pendingAttachments[index];
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(item.previewUrl);
        }
        state.pendingAttachments.splice(index, 1);
        renderPendingAttachments();
        updateSendButtonState();
    }
}

function clearPendingAttachments() {
    for (const item of state.pendingAttachments) {
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(item.previewUrl);
        }
    }
    state.pendingAttachments = [];
    renderPendingAttachments();
    updateSendButtonState();
}

function renderPendingAttachments() {
    const container = document.getElementById('attachments-preview')!;
    if (!container)
        return;
    if (state.pendingAttachments.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = 'flex';
    let html = '';
    state.pendingAttachments.forEach((item, index) => {
        if (item.kind === 'image') {
            html += `
            <div class="pending-chip pending-image-chip">
              <img src="${escapeHtml(item.previewUrl)}" class="pending-thumb" alt="${escapeHtml(item.name)}">
              <div class="pending-meta">
                <span class="pending-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                <span class="pending-size">${escapeHtml(formatFileSize(item.size))}</span>
              </div>
              <button type="button" class="btn-remove-pending" onclick="removePendingAttachment(${index})" title="移除此附件" aria-label="移除">×</button>
            </div>
          `;
        }
        else {
            html += `
            <div class="pending-chip pending-text-chip">
              <span class="pending-file-icon">📄</span>
              <div class="pending-meta">
                <span class="pending-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                <span class="pending-size">${escapeHtml(formatFileSize(item.size))}</span>
              </div>
              <button type="button" class="btn-remove-pending" onclick="removePendingAttachment(${index})" title="移除此附件" aria-label="移除">×</button>
            </div>
          `;
        }
    });
    container.innerHTML = html;
}

function updateSendButtonState() {
    const textarea = (document.getElementById('chat-textarea') as HTMLTextAreaElement);
    const btnSend = (document.getElementById('btn-send') as HTMLButtonElement);
    if (!btnSend)
        return;
    const text = (textarea ? textarea.value : '').trim();
    const canSend = (text.length > 0 || state.pendingAttachments.length > 0) && !state.isSending;
    btnSend.disabled = !canSend;
}

function triggerFileInput() {
    const fileInput = (document.getElementById('file-input') as HTMLInputElement);
    if (fileInput) {
        fileInput.value = '';
        fileInput.click();
    }
}

function setupDragAndDrop() {
    const chatColumn = document.querySelector<HTMLElement>('.chat-column');
    const dropOverlay = document.getElementById('drop-overlay')!;
    if (!chatColumn || !dropOverlay)
        return;
    let dragCounter = 0;
    chatColumn.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            dragCounter++;
            dropOverlay.style.display = 'flex';
        }
    });
    chatColumn.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
        }
    });
    chatColumn.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropOverlay.style.display = 'none';
        }
    });
    chatColumn.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropOverlay.style.display = 'none';
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            await handleFilesSelected(e.dataTransfer.files);
        }
    });
}
return { updateSendButtonState, clearPendingAttachments, setupDragAndDrop, handleFilesSelected, triggerFileInput, removePendingAttachment };
}
