// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Chat, type ChatProps } from './Chat';
import type { UploadedAttachment } from '../state';
import { MAX_ATTACHMENTS_PER_TURN } from '../../shared/protocol';
import { PASTE_CHIP_MIN_CHARS, PASTE_CHIP_MIN_LINES, isLongPaste, lineCount } from '../upload';

Element.prototype.scrollIntoView = () => {};

/** Chat with the attachment list held in state, as the pane does. */
function Harness({ uploadFn, onSend, initial = [] }: { uploadFn: ChatProps['uploadFn']; onSend: (t: string) => void; initial?: UploadedAttachment[] }) {
  const [attachments, setAttachments] = useState<UploadedAttachment[]>(initial);
  return (
    <Chat items={[]} pending={[]} questions={[]} activeTurnId={null} busy={false} title="t" model="opus" effort="high" engine="claude" sandbox="read-only" sessionEngine={null} sessionSandbox={null} isNew={false} codexAvailable={false}
      attachments={attachments} uploadFn={uploadFn}
      onSend={(t) => { onSend(t); setAttachments([]); }}
      onInterrupt={() => {}} onDecide={() => {}} onAnswer={() => {}} onModel={() => {}} onEffort={() => {}} onEngine={() => {}} onSandbox={() => {}}
      onAttach={(a) => setAttachments((l) => [...l, a])} onUnattach={(id) => setAttachments((l) => l.filter((a) => a.id !== id))} />
  );
}

function setup({ initial = [], fail = false }: { initial?: UploadedAttachment[]; fail?: boolean } = {}) {
  let n = 0;
  const uploadFn = vi.fn(async (f: File): Promise<UploadedAttachment> => {
    if (fail) throw new Error('업로드 실패: 네트워크 오류');
    return { id: `id-${++n}`, name: f.name, size: f.size, isImage: false };
  });
  const onSend = vi.fn();
  render(<Harness uploadFn={uploadFn} onSend={onSend} initial={initial} />);
  const ta = screen.getByLabelText('메시지') as HTMLTextAreaElement;
  const paste = (text: string) => fireEvent.paste(ta, { clipboardData: { files: [], items: [], getData: (t: string) => (t === 'text/plain' ? text : '') } });
  return { uploadFn, onSend, ta, paste };
}

const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

describe('long paste → 붙여넣은 텍스트 chip', () => {
  afterEach(cleanup);

  it('thresholds: either limit makes it long', () => {
    expect(isLongPaste('a'.repeat(PASTE_CHIP_MIN_CHARS - 1))).toBe(false);
    expect(isLongPaste('a'.repeat(PASTE_CHIP_MIN_CHARS))).toBe(true);
    expect(isLongPaste('a\n'.repeat(PASTE_CHIP_MIN_LINES - 2) + 'a')).toBe(false);
    expect(isLongPaste('a\n'.repeat(PASTE_CHIP_MIN_LINES - 1) + 'a')).toBe(true);
    expect(lineCount('a\r\nb\rc\nd')).toBe(4);
  });

  it('a short paste is left to the textarea (no upload, default not prevented)', () => {
    const { uploadFn, paste } = setup();
    expect(paste('짧은 텍스트')).toBe(true);
    expect(uploadFn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pasted-chip')).toBeNull();
  });

  it('a long paste uploads pasted-1.txt and shows a chip (N줄 · M자) instead of composer text; click previews; × removes', async () => {
    const { uploadFn, ta, paste } = setup();
    fireEvent.change(ta, { target: { value: '설명: ' } });
    expect(paste(long)).toBe(false);
    await waitFor(() => expect(screen.getByTestId('pasted-chip')).toBeTruthy());
    const f = uploadFn.mock.calls[0]![0];
    expect(f.name).toBe('pasted-1.txt');
    expect(f.type).toBe('text/plain');
    expect(f.size).toBe(new TextEncoder().encode(long).length);
    expect(ta.value).toBe('설명: ');
    const chip = screen.getByTestId('pasted-chip');
    expect(chip.textContent).toContain('붙여넣은 텍스트');
    expect(chip.textContent).toContain(`30줄 · ${long.length}자`);
    fireEvent.click(within(chip).getByTitle('붙여넣은 내용 보기'));
    expect(screen.getByRole('dialog', { name: '붙여넣은 텍스트 미리보기' }).textContent).toBe(long);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(chip).getByLabelText('첨부 제거'));
    expect(screen.queryByTestId('pasted-chip')).toBeNull();
  });

  it('two pastes are two chips, pasted-1.txt and pasted-2.txt; after sending, numbering starts again', async () => {
    const { uploadFn, onSend, paste } = setup();
    paste(long);
    paste('x'.repeat(PASTE_CHIP_MIN_CHARS));
    await waitFor(() => expect(screen.getAllByTestId('pasted-chip')).toHaveLength(2));
    expect(uploadFn.mock.calls.map((c) => c[0].name)).toEqual(['pasted-1.txt', 'pasted-2.txt']);
    fireEvent.click(screen.getByText('보내기'));
    expect(onSend).toHaveBeenCalledWith('첨부 파일을 확인해 주세요.');
    await waitFor(() => expect(screen.queryByTestId('pasted-chip')).toBeNull());
    paste(long);
    await waitFor(() => expect(uploadFn).toHaveBeenCalledTimes(3));
    expect(uploadFn.mock.calls[2]![0].name).toBe('pasted-1.txt');
  });

  it('with the attachments full, a long paste stays plain text (default kept, no upload)', () => {
    const full = Array.from({ length: MAX_ATTACHMENTS_PER_TURN }, (_, i) => ({ id: `f${i}`, name: `f${i}.txt`, size: 1, isImage: false }));
    const { uploadFn, paste } = setup({ initial: full });
    expect(paste(long)).toBe(true);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('while another attachment is still uploading, a long paste still becomes a chip; sending waits for both', async () => {
    const gates: (() => void)[] = [];
    let n = 0;
    const uploadFn = vi.fn((f: File) => new Promise<UploadedAttachment>((res) => { gates.push(() => res({ id: `id-${++n}`, name: f.name, size: f.size, isImage: false })); }));
    const onSend = vi.fn();
    render(<Harness uploadFn={uploadFn} onSend={onSend} />);
    const ta = screen.getByLabelText('메시지') as HTMLTextAreaElement;
    const img = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(ta, { clipboardData: { files: [img], items: [], getData: () => '' } });
    await waitFor(() => expect(uploadFn).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/업로드 중 1/)).toBeTruthy();
    const ev = fireEvent.paste(ta, { clipboardData: { files: [], items: [], getData: (t: string) => (t === 'text/plain' ? long : '') } });
    expect(ev).toBe(false);
    expect(ta.value).toBe('');
    await waitFor(() => expect(uploadFn).toHaveBeenCalledTimes(2));
    expect(uploadFn.mock.calls[1]![0].name).toBe('pasted-1.txt');
    expect((screen.getByText('보내기').closest('button') as HTMLButtonElement).disabled).toBe(true);
    gates[0]!();
    await waitFor(() => expect(screen.getByText(/업로드 중 1/)).toBeTruthy());
    expect((screen.getByText('보내기').closest('button') as HTMLButtonElement).disabled).toBe(true);
    gates[1]!();
    await waitFor(() => expect(screen.getByTestId('pasted-chip')).toBeTruthy());
    expect((screen.getByText('보내기').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('files still queued behind the one uploading count: with them filling the attachments, a long paste stays text', async () => {
    const uploadFn = vi.fn((_f: File) => new Promise<UploadedAttachment>(() => {}));
    render(<Harness uploadFn={uploadFn} onSend={() => {}} />);
    const ta = screen.getByLabelText('메시지') as HTMLTextAreaElement;
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_TURN }, (_, i) => new File(['x'], `f${i}.png`, { type: 'image/png' }));
    fireEvent.paste(ta, { clipboardData: { files, items: [], getData: () => '' } });
    await waitFor(() => expect(uploadFn).toHaveBeenCalledTimes(1)); // one at a time: the rest wait in the queue
    const ev = fireEvent.paste(ta, { clipboardData: { files: [], items: [], getData: (t: string) => (t === 'text/plain' ? long : '') } });
    expect(ev).toBe(true);
    expect(uploadFn).toHaveBeenCalledTimes(1);
  });

  it('a long paste whose upload fails goes back into the composer, nothing lost', async () => {
    const { uploadFn, ta, paste } = setup({ fail: true });
    fireEvent.change(ta, { target: { value: '설명: ' } });
    expect(paste(long)).toBe(false);
    await waitFor(() => expect(ta.value).toBe(`설명: ${long}`));
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pasted-chip')).toBeNull();
  });
});
