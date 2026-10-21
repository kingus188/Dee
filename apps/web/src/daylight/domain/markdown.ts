import { generateText, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Markdown, MarkdownManager } from '@tiptap/markdown'

// ponytail: inline images keep SQLite saves atomic; use attachments if notes outgrow 8 MiB.
export const MAX_DESCRIPTION_BYTES = 8 * 1024 * 1024
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

export function descriptionTooLarge(value: string) {
  return new TextEncoder().encode(value).byteLength > MAX_DESCRIPTION_BYTES
}

export function safeImageSource(src: unknown): src is string {
  return (
    typeof src === 'string' &&
    (/^https:\/\//i.test(src) ||
      /^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(src))
  )
}

export const markdownExtensions = [
  StarterKit.configure({
    link: { openOnClick: false },
    underline: false,
  }),
  Image.extend({
    renderHTML({ HTMLAttributes }) {
      return [
        'img',
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
          src: safeImageSource(HTMLAttributes.src) ? HTMLAttributes.src : null,
        }),
      ]
    },
  }).configure({ allowBase64: true }),
  Markdown,
]

const markdown = new MarkdownManager({ extensions: markdownExtensions })

export function markdownText(value: string) {
  return generateText(markdown.parse(value), markdownExtensions, {
    blockSeparator: '\n',
    textSerializers: { image: () => '[图片]' },
  })
}

export async function readImage(file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type))
    throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片。')
  if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 2 MiB。')
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败，请重新粘贴。'))
    reader.onabort = () => reject(new Error('图片读取已取消，请重试。'))
    reader.readAsDataURL(file)
  })
  const image = new window.Image()
  image.src = src
  try {
    await image.decode()
  } catch {
    throw new Error('图片无法解码，请换一张图片。')
  }
  return src
}
