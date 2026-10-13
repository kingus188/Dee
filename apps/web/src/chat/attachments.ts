import type { PendingAttachment } from "../types.js";

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

export async function processAttachmentFile(file: File): Promise<PendingAttachment | {
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
