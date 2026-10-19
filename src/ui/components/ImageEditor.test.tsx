// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AttachmentBar } from './AttachmentBar';
import { ImageEditor } from './ImageEditor';
import { MAX_ATTACHMENT_BYTES } from '../../shared/protocol';
import { REPLACE_GONE, replaceAttachment } from '../upload';
import type { UploadedAttachment } from '../state';

/** jsdom has no image decoding and no 2D canvas: a fake <img> of 400×300 and a context that records its calls. */
class FakeImage {
  decoding = '';
  src = '';
  naturalWidth = 400;
  naturalHeight = 300;
  decode() { return Promise.resolve(); }
}
let calls: [string, unknown[]][] = [];
const ctx = new Proxy({} as Record<string, unknown>, {
  get: (t, k) => (k === 'then' ? undefined : k in t ? t[k as string] : (...args: unknown[]) => { calls.push([String(k), args]); }),
  set: (t, k, v) => { t[k as string] = v; calls.push([`=${String(k)}`, [v]]); return true; },
});
let blobs: { w: number; h: number; type: string; q?: number }[] = [];
let blobSize: (type: string, q?: number) => number = () => 3;
const realRevoke = URL.revokeObjectURL;

beforeEach(() => {
  blobs = [];
  calls = [];
  blobSize = () => 3;
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string, q?: unknown) {
    const t = type ?? 'image/png';
    blobs.push({ w: this.width, h: this.height, type: t, ...(typeof q === 'number' ? { q } : {}) });
    cb(new Blob([new Uint8Array(blobSize(t, q as number | undefined))], { type: t }));
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); URL.revokeObjectURL = realRevoke; });

const shot: UploadedAttachment = { id: 'a1', name: 'shot.png', size: 2048, isImage: true, previewUrl: 'blob:shot' };
const notes: UploadedAttachment = { id: 'a2', name: 'notes.md', size: 10, isImage: false };

async function openEditor(onReplace = vi.fn(async (): Promise<string | void> => {})) {
  render(<AttachmentBar attachments={[shot, notes]} uploading={0} error={null} onRemove={() => {}} onReplace={onReplace} />);
  expect(screen.queryByLabelText('이미지 편집: notes.md')).toBeNull(); // only images open the editor
  fireEvent.click(screen.getByLabelText('이미지 편집: shot.png'));
  await screen.findByTestId('image-editor-canvas');
  return onReplace;
}
const drag = (from: Element, stage: Element, id: number, a: [number, number], b: [number, number]) => {
  fireEvent.pointerDown(from, { pointerId: id, clientX: a[0], clientY: a[1], button: 0 });
  fireEvent.pointerMove(stage, { pointerId: id, clientX: b[0], clientY: b[1] });
  fireEvent.pointerUp(stage, { pointerId: id, clientX: b[0], clientY: b[1] });
};
const done = async () => { await act(async () => { fireEvent.click(screen.getByLabelText('편집 완료')); }); };

/** A composer in miniature: live attachment list, replaceAttachment with a controllable upload. */
function Harness({ upload }: { upload: (f: File) => Promise<UploadedAttachment> }) {
  const [list, setList] = useState<UploadedAttachment[]>([shot, notes]);
  const live = useRef(list);
  live.current = list;
  return (
    <div className="composer">
      <textarea aria-label="메시지" />
      <button type="button" onClick={() => setList((l) => l.filter((a) => a.id !== 'a1'))}>remove-shot</button>
      <AttachmentBar attachments={list} uploading={0} error={null} onRemove={() => {}}
        onReplace={(old, f) => replaceAttachment(old, f, upload, () => live.current, (a) => setList((l) => l.map((x) => (x.id === old.id ? a : x))))} />
    </div>
  );
}

describe('ImageEditor (attachment image editing)', () => {
  it('an image chip says it can be edited in words (touch screens have no hover), files do not', () => {
    render(<AttachmentBar attachments={[shot, notes]} uploading={0} error={null} onRemove={() => {}} onReplace={async () => {}} />);
    const btn = screen.getByLabelText('이미지 편집: shot.png');
    expect(btn.querySelector('.attach-edit-cue')?.textContent).toBe('편집');
    expect(document.querySelectorAll('.attach-edit-cue')).toHaveLength(1);
  });

  it('without onReplace (read-only composer) there is no 편집 cue', () => {
    render(<AttachmentBar attachments={[shot]} uploading={0} error={null} onRemove={() => {}} />);
    expect(document.querySelector('.attach-edit-cue')).toBeNull();
  });

  it('opens from the image chip; 취소 and Esc leave the attachment alone; focus returns to the chip', async () => {
    const onReplace = await openEditor();
    expect(screen.getByRole('dialog', { name: '이미지 편집' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('오른쪽으로 90도 회전'));
    fireEvent.click(screen.getByLabelText('편집 취소'));
    expect(screen.queryByTestId('image-editor')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('이미지 편집: shot.png'));

    fireEvent.click(screen.getByLabelText('이미지 편집: shot.png'));
    await screen.findByTestId('image-editor-canvas');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('image-editor')).toBeNull();
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('is modal: everything outside the editor is inert while it is open', async () => {
    await openEditor();
    const app = document.body.firstElementChild!;
    expect(app.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('image-editor').hasAttribute('inert')).toBe(false);
    fireEvent.click(screen.getByLabelText('편집 취소'));
    expect(app.hasAttribute('inert')).toBe(false);
  });

  it('완료 with nothing changed just closes', async () => {
    const onReplace = await openEditor();
    fireEvent.click(screen.getByLabelText('편집 완료'));
    expect(screen.queryByTestId('image-editor')).toBeNull();
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('rotate + 완료: the full-resolution PNG goes to onReplace for that attachment, then the editor closes', async () => {
    const onReplace = await openEditor();
    fireEvent.click(screen.getByLabelText('오른쪽으로 90도 회전'));
    await done();
    await waitFor(() => expect(onReplace).toHaveBeenCalledTimes(1));
    const [old, file] = onReplace.mock.calls[0] as unknown as [UploadedAttachment, File];
    expect(old.id).toBe('a1');
    expect(file.name).toBe('shot.png');
    expect(file.type).toBe('image/png');
    expect(blobs.at(-1)).toEqual({ w: 300, h: 400, type: 'image/png' }); // turned: 400×300 → 300×400
    await waitFor(() => expect(screen.queryByTestId('image-editor')).toBeNull());
  });

  it('rotate → crop → pen: the output draws the crop of the turned image, strokes in original coordinates', async () => {
    const onReplace = await openEditor();
    fireEvent.click(screen.getByLabelText('오른쪽으로 90도 회전')); // now 300×400
    const stage = screen.getByTestId('image-editor-canvas');
    drag(stage.querySelector('[data-handle="nw"]')!, stage, 1, [0, 0], [100, 50]); // crop {100, 50, 200, 350}
    fireEvent.click(screen.getByLabelText('펜으로 표시'));
    drag(stage, stage, 2, [150, 100], [160, 120]);
    calls = [];
    await done();
    await waitFor(() => expect(onReplace).toHaveBeenCalled());
    expect(blobs.at(-1)).toMatchObject({ w: 200, h: 350 });
    const seq = calls.filter(([k]) => ['setTransform', 'translate', 'rotate', 'drawImage', 'moveTo', 'lineTo'].includes(k));
    expect(seq.map(([k]) => k)).toEqual(['setTransform', 'translate', 'rotate', 'drawImage', 'moveTo', 'lineTo']);
    expect(seq[0]![1]).toEqual([1, 0, 0, 1, -100, -50]);
    expect(seq[1]![1]).toEqual([300, 0]); // 90°: the original's height across
    expect(seq[2]![1]).toEqual([Math.PI / 2]);
    expect((seq[3]![1] as unknown[]).slice(1)).toEqual([0, 0, 400, 300]); // the whole original, full size
    expect(seq[4]![1]).toEqual([100, 150]); // rotated (150, 100) → original (100, 300 - 150)
    expect(seq[5]![1]).toEqual([120, 140]);
  });

  it('crop by dragging a handle; pen strokes undo; a failed upload keeps the editor open', async () => {
    const onReplace = vi.fn(async (): Promise<string | void> => { throw new Error('업로드 실패 (500)'); });
    await openEditor(onReplace);
    const stage = screen.getByTestId('image-editor-canvas');
    drag(stage.querySelector('[data-handle="se"]')!, stage, 1, [400, 300], [200, 150]);
    const undo = screen.getByLabelText('되돌리기') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);

    fireEvent.click(screen.getByLabelText('펜으로 표시'));
    expect(stage.querySelector('[data-handle]')).toBeNull(); // no crop handles while drawing
    drag(stage, stage, 2, [10, 10], [50, 40]);
    fireEvent.click(undo); // the stroke goes, the crop stays

    await done();
    await waitFor(() => expect(onReplace).toHaveBeenCalledTimes(1));
    expect(blobs.at(-1)).toMatchObject({ w: 200, h: 150 });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '업로드 실패 (500)');
    expect(screen.getByTestId('image-editor')).toBeTruthy();
  });

  it('1:1 makes a centered square (undone with its ratio); a JPEG comes out JPEG on white', async () => {
    const onDone = vi.fn();
    render(<ImageEditor src="blob:x" name="photo.jpg" onCancel={() => {}} onDone={onDone} />);
    await screen.findByTestId('image-editor-canvas');
    const square = screen.getByLabelText('1:1 정사각형');
    fireEvent.click(square);
    const crop = screen.getByTestId('image-editor-crop');
    expect(crop.style.width).toBe('300px');
    expect(crop.style.left).toBe('50px');
    expect(screen.getByTestId('image-editor-canvas').querySelectorAll('[data-handle]').length).toBe(4); // corners only
    fireEvent.click(screen.getByLabelText('되돌리기'));
    expect(square.getAttribute('aria-pressed')).toBe('false');
    expect(crop.style.width).toBe('400px');
    fireEvent.click(square);
    calls = [];
    await done();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const file = onDone.mock.calls[0]![0] as File;
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toBe('photo.jpg');
    expect(blobs.at(-1)).toEqual({ w: 300, h: 300, type: 'image/jpeg', q: 0.92 });
    expect(calls).toContainEqual(['=globalCompositeOperation', ['destination-over']]);
    expect(calls).toContainEqual(['=fillStyle', ['#fff']]);
  });

  it('over the upload limit: PNG becomes JPEG, JPEG steps its quality down', async () => {
    blobSize = (t, q) => (t === 'image/png' || (q ?? 1) > 0.8 ? MAX_ATTACHMENT_BYTES + 1 : 10);
    const onDone = vi.fn();
    render(<ImageEditor src="blob:x" name="big.png" onCancel={() => {}} onDone={onDone} />);
    await screen.findByTestId('image-editor-canvas');
    fireEvent.click(screen.getByLabelText('오른쪽으로 90도 회전'));
    await done();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(blobs.map((b) => [b.type, b.q])).toEqual([['image/png', undefined], ['image/jpeg', 0.92], ['image/jpeg', 0.85], ['image/jpeg', 0.75]]);
    expect((onDone.mock.calls[0]![0] as File).name).toBe('big.jpg');
  });

  it('shows the load error when the image cannot be opened', async () => {
    render(<ImageEditor src="blob:x" name="x.png" onCancel={() => {}} onDone={() => {}} load={() => Promise.reject(new Error('이미지를 열 수 없습니다'))} />);
    expect((await screen.findByRole('alert')).textContent).toBe('이미지를 열 수 없습니다');
    expect((screen.getByLabelText('편집 완료') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('replacing an edited attachment', () => {
  it('swaps the chip in place and focuses the new one', async () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const upload = vi.fn(async (f: File) => ({ id: 'a3', name: f.name, size: f.size, isImage: true, previewUrl: 'blob:new' }));
    render(<Harness upload={upload} />);
    fireEvent.click(screen.getByLabelText('이미지 편집: shot.png'));
    await screen.findByTestId('image-editor-canvas');
    fireEvent.click(screen.getByLabelText('오른쪽으로 90도 회전'));
    await done();
    await waitFor(() => expect(screen.queryByTestId('image-editor')).toBeNull());
    expect(revoke).toHaveBeenCalledWith('blob:shot'); // the old preview, once swapped
    const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-attachment-id]')).map((el) => el.dataset.attachmentId);
    expect(chips).toEqual(['a3', 'a2']);
    expect(document.activeElement?.closest('[data-attachment-id]')?.getAttribute('data-attachment-id')).toBe('a3');
  });

  it('race: the attachment is removed while the edit uploads — editor closes, new preview released, nothing swapped', async () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    let finish!: (a: UploadedAttachment) => void;
    const upload = vi.fn(() => new Promise<UploadedAttachment>((res) => { finish = res; }));
    render(<Harness upload={upload} />);
    fireEvent.click(screen.getByLabelText('이미지 편집: shot.png'));
    await screen.findByTestId('image-editor-canvas');
    fireEvent.click(screen.getByLabelText('오른쪽으로 90도 회전'));
    await done();
    await waitFor(() => expect(upload).toHaveBeenCalled());
    fireEvent.click(screen.getByText('remove-shot')); // e.g. sent from another device / pane cleared
    expect(screen.queryByTestId('image-editor')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('메시지')); // chip gone: back to the composer
    await act(async () => { finish({ id: 'a3', name: 'shot.png', size: 3, isImage: true, previewUrl: 'blob:new' }); });
    expect(revoke).toHaveBeenCalledWith('blob:new');
    expect(revoke).not.toHaveBeenCalledWith('blob:shot');
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-attachment-id]')).map((el) => el.dataset.attachmentId)).toEqual(['a2']);
  });

  it('replaceAttachment refuses when the original is gone', async () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const apply = vi.fn();
    const p = replaceAttachment(shot, new File(['x'], 'shot.png'), async () => ({ id: 'n', name: 'shot.png', size: 1, isImage: true, previewUrl: 'blob:n' }), () => [notes], apply);
    await expect(p).rejects.toThrow(REPLACE_GONE);
    expect(apply).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:n');
  });
});
