import fs from 'node:fs/promises';
import { IMAGE_TYPES, promptWithFiles, type Attachment } from '../../attachments/AttachmentStore';
import type { CliUserMessage, ContentBlock } from './messages';

export type ReadFile = (p: string) => Promise<Buffer>;

/**
 * D7/D14: one stdin user message. Non-image attachments become path lines in the text; images
 * become base64 image blocks next to it. `session_id: ''` is what the SDK used to write.
 */
export async function toUserMessage(text: string, attachments: Attachment[], readFile: ReadFile = (p) => fs.readFile(p)): Promise<CliUserMessage> {
  const body = promptWithFiles(text, attachments);
  const images = attachments.filter((a) => a.isImage && IMAGE_TYPES.has(a.mediaType));
  if (!images.length) return { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: body } };
  const content: ContentBlock[] = [{ type: 'text', text: body }];
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: (await readFile(img.path)).toString('base64') } });
  }
  return { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
}
