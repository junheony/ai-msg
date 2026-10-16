import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { MAX_ATTACHMENT_BYTES } from '../../shared/protocol';
import {
  CORNER_HANDLES, HANDLES, JPEG_QUALITIES, editedName, fitAspect, fitScale, fromRotated, fullRect, moveRect, nextRotation, outputScale, outputType,
  penWidth, pixelRect, resizeRect, rotateRectCW, rotatedSize, rotationTransform, sameRect,
  type Handle, type Point, type Rect, type Rotation, type Size,
} from '../imageEdit';

export type LoadedImage = { source: CanvasImageSource; w: number; h: number; release?: () => void };

/**
 * Decodes `src` (the composer's blob: preview or /api/attachments/<id>; both same-origin, so the canvas stays readable).
 * <img> applies the EXIF orientation (CSS image-orientation: from-image, the default) to its natural size and to
 * drawImage in current Safari, Chrome and Firefox — the editor works on the image as the user sees it.
 */
export async function loadImage(src: string): Promise<LoadedImage> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  const release = () => { img.src = ''; }; // lets the browser drop the decoded bitmap
  try {
    await img.decode();
  } catch {
    release();
    throw new Error('이미지를 열 수 없습니다');
  }
  return { source: img, w: img.naturalWidth, h: img.naturalHeight, release };
}

type Mode = 'crop' | 'pen';
type Ratio = 'free' | 'original' | 'square';
/** One undo step: everything 되돌리기 puts back. */
type Snapshot = { rotation: Rotation; crop: Rect; strokes: Point[][]; ratio: Ratio };
type Drag = { id: number; kind: 'move' | 'resize' | 'pen'; handle?: Handle; start: Point; startCrop: Rect; before: Snapshot };

const PEN_COLOR = '#ff3b30';
const MIN_CROP_PX = 32; // on screen

/** Wide-gamut canvas where the screen has it (iPhone/Mac screenshots are Display P3); elsewhere the default sRGB. */
function context2d(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const p3 = typeof window.matchMedia === 'function' && window.matchMedia('(color-gamut: p3)').matches;
  return p3 ? c.getContext('2d', { colorSpace: 'display-p3' }) : c.getContext('2d');
}

/** The rotated image with its pen strokes, in the context's current transform (1 unit = 1 image pixel). */
function paint(ctx: CanvasRenderingContext2D, img: LoadedImage, s: Pick<Snapshot, 'rotation' | 'strokes'>) {
  const size = { w: img.w, h: img.h };
  const { tx, ty, angle } = rotationTransform(size, s.rotation);
  ctx.translate(tx, ty);
  ctx.rotate(angle);
  ctx.drawImage(img.source, 0, 0, img.w, img.h);
  ctx.strokeStyle = PEN_COLOR;
  ctx.lineWidth = penWidth(size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const line of s.strokes) {
    const [first, ...rest] = line;
    if (!first) continue;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y); // a tap leaves a dot
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
}

const toBlob = (c: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, quality));

/** JPEG has no alpha: paint white under what's drawn (transparent PNG/GIF areas would turn black). */
function whiteBehind(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();
}

/** The edit at full resolution: crop of the rotated original, strokes included. */
async function render(img: LoadedImage, s: Snapshot, name: string): Promise<File> {
  const rs = rotatedSize({ w: img.w, h: img.h }, s.rotation);
  const px = pixelRect(s.crop, rs);
  const k = outputScale(px);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(px.w * k));
  canvas.height = Math.max(1, Math.round(px.h * k));
  const ctx = context2d(canvas);
  if (!ctx) throw new Error('이 브라우저에서는 이미지를 편집할 수 없습니다');
  ctx.setTransform(k, 0, 0, k, -px.x * k, -px.y * k);
  paint(ctx, img, s);
  try {
    let type = outputType(name);
    let blob = type === 'image/png' ? await toBlob(canvas, type) : null;
    // A photo-like PNG over the upload limit goes as JPEG instead; JPEG steps its quality down until it fits.
    if (!blob || blob.size > MAX_ATTACHMENT_BYTES) {
      type = 'image/jpeg';
      whiteBehind(ctx, canvas);
      for (const q of JPEG_QUALITIES) {
        blob = await toBlob(canvas, type, q);
        if (!blob || blob.size <= MAX_ATTACHMENT_BYTES) break;
      }
    }
    if (!blob) throw new Error('이미지를 만들지 못했습니다');
    if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error(`편집한 이미지가 너무 큽니다(최대 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB)`);
    return new File([blob], editedName(name, type), { type });
  } finally {
    canvas.width = 0; // iOS Safari keeps canvas memory until the size drops
    canvas.height = 0;
  }
}

const svg = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const CropIcon = () => <svg {...svg}><path d="M5 1.5V13h11.5" /><path d="M1.5 5H13v11.5" /></svg>;
const PenIcon = () => <svg {...svg}><path d="M3 15l1-4 8.5-8.5a1.4 1.4 0 0 1 2 2L6 13z" /><path d="M11 4l3 3" /></svg>;
const RotateIcon = () => <svg {...svg}><path d="M14.5 9A5.5 5.5 0 1 1 12.6 4.8" /><path d="M13 1.8v3.4H9.6" /></svg>;
const UndoIcon = () => <svg {...svg}><path d="M6 4L2.5 7.5 6 11" /><path d="M2.5 7.5H11a4.5 4.5 0 0 1 0 9H8" /></svg>;

/**
 * Full-screen editor for an attached image: crop (drag the box or its handles; 자유 / 원본 / 1:1), rotate 90°, a red pen
 * and 되돌리기. Shown scaled to the screen, cut at the original resolution. 완료 hands the result to `onDone` as a PNG
 * (a JPEG stays JPEG) — nothing edited: just closes; 취소 or Esc leave the attachment as it was.
 */
export function ImageEditor({ src, name, onCancel, onDone, load = loadImage }: {
  src: string;
  name: string;
  onCancel: () => void;
  /** Rejecting keeps the editor open with the message shown. */
  onDone: (file: File) => Promise<void> | void;
  load?: (src: string) => Promise<LoadedImage>;
}) {
  const [img, setImg] = useState<LoadedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('crop');
  const [snap, setSnap] = useState<Snapshot>({ rotation: 0, crop: { x: 0, y: 0, w: 0, h: 0 }, strokes: [], ratio: 'free' });
  const [past, setPast] = useState<Snapshot[]>([]);
  const [avail, setAvail] = useState<Size>({ w: 0, h: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shownCanvas = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    let live = true;
    let loaded: LoadedImage | null = null;
    load(src).then((li) => {
      loaded = li;
      if (!live) { li.release?.(); return; }
      setImg(li);
      setSnap({ rotation: 0, crop: fullRect({ w: li.w, h: li.h }), strokes: [], ratio: 'free' });
    }, (err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; loaded?.release?.(); };
  }, [src, load]);

  // Modal for real: the rest of the page is inert (no Tab, no taps, no screen reader) while the editor — a portal, so
  // a sibling of the app root — is open. One Esc closes the editor only (not the side panel, not the running turn).
  // The opener (AttachmentBar) puts focus back afterwards.
  useEffect(() => {
    const root = rootRef.current;
    const made = Array.from(document.body.children).filter((el) => el !== root && !el.hasAttribute('inert'));
    for (const el of made) el.setAttribute('inert', '');
    root?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!busyRef.current) cancelRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      for (const el of made) el.removeAttribute('inert');
      const c = shownCanvas.current; // released with the editor (iOS keeps canvas memory until the size drops)
      if (c) { c.width = 0; c.height = 0; }
    };
  }, []);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0;
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0;
      setAvail({ w: Math.max(0, el.clientWidth - padX), h: Math.max(0, el.clientHeight - padY) });
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const size: Size = img ? { w: img.w, h: img.h } : { w: 0, h: 0 };
  const rs = rotatedSize(size, snap.rotation);
  const scale = fitScale(rs, avail);
  const dw = Math.max(1, Math.round(rs.w * scale));
  const dh = Math.max(1, Math.round(rs.h * scale));
  const aspect = snap.ratio === 'square' ? 1 : snap.ratio === 'original' ? rs.w / rs.h : null;
  const { rotation, strokes } = snap;

  // Display canvas: device pixels for a sharp preview, never more than the image itself has. Only the image, rotation,
  // strokes and scale redraw it — dragging the crop box moves the overlay alone.
  useEffect(() => {
    const c = canvasRef.current;
    if (!img || !c) return;
    shownCanvas.current = c;
    const r = rotatedSize({ w: img.w, h: img.h }, rotation);
    const dpr = Math.min(typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1, 3);
    const k = Math.min(1, scale * dpr);
    c.width = Math.max(1, Math.round(r.w * k));
    c.height = Math.max(1, Math.round(r.h * k));
    const ctx = context2d(c);
    if (!ctx) return;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, r.w, r.h);
    paint(ctx, img, { rotation, strokes });
  }, [img, rotation, strokes, scale]);

  const commit = (before: Snapshot, next: Snapshot) => { setPast((p) => [...p, before]); setSnap(next); };
  const pointAt = (e: ReactPointerEvent<HTMLElement>): Point => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - box.left) / scale, y: (e.clientY - box.top) / scale };
  };
  const inBounds = (p: Point): Point => ({ x: Math.min(rs.w, Math.max(0, p.x)), y: Math.min(rs.h, Math.max(0, p.y)) });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!img || busy || drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const p = pointAt(e);
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle as Handle | undefined;
    const c = snap.crop;
    let kind: Drag['kind'];
    if (mode === 'pen') kind = 'pen';
    else if (handle) kind = 'resize';
    else if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) kind = 'move';
    else return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, kind, ...(handle ? { handle } : {}), start: p, startCrop: c, before: snap };
    if (kind === 'pen') setSnap({ ...snap, strokes: [...snap.strokes, [fromRotated(inBounds(p), size, snap.rotation)]] });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = pointAt(e);
    if (d.kind === 'pen') {
      const q = fromRotated(inBounds(p), size, snap.rotation);
      setSnap((s) => {
        const last = s.strokes[s.strokes.length - 1] ?? [];
        return { ...s, strokes: [...s.strokes.slice(0, -1), [...last, q]] };
      });
    } else if (d.kind === 'move') {
      setSnap((s) => ({ ...s, crop: moveRect(d.startCrop, p.x - d.start.x, p.y - d.start.y, rs) }));
    } else if (d.handle) {
      const min = MIN_CROP_PX / scale;
      setSnap((s) => ({ ...s, crop: resizeRect(d.startCrop, d.handle!, p, rs, min, aspect) }));
    }
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.kind === 'pen' || !sameRect(d.before.crop, snap.crop, 0)) setPast((p) => [...p, d.before]);
  };

  const rotate = () => commit(snap, { ...snap, rotation: nextRotation(snap.rotation), crop: rotateRectCW(snap.crop, rs) });
  const pickRatio = (r: Ratio) => {
    if (r === snap.ratio) return;
    const crop = r === 'free' ? snap.crop : fitAspect(fullRect(rs), r === 'square' ? 1 : rs.w / rs.h);
    commit(snap, { ...snap, ratio: r, crop });
  };
  const undo = () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    setPast(past.slice(0, -1));
    setSnap(prev);
  };
  const done = async () => {
    if (!img || busy) return;
    if (snap.rotation === 0 && snap.strokes.length === 0 && sameRect(snap.crop, fullRect(size))) { onCancel(); return; }
    setBusy(true);
    setError(null);
    try {
      await onDone(await render(img, snap, name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handles = aspect ? CORNER_HANDLES : HANDLES;
  const c = snap.crop;
  return createPortal(
    <div ref={rootRef} className="img-editor" role="dialog" aria-modal="true" aria-label="이미지 편집" tabIndex={-1} data-testid="image-editor">
      <div className="img-editor-bar">
        <button type="button" className="btn ghost" aria-label="편집 취소" disabled={busy} onClick={onCancel}>취소</button>
        <span className="img-editor-title" title={name}>{name}</span>
        <button type="button" className="btn primary" aria-label="편집 완료" disabled={!img || busy} onClick={() => void done()}>{busy ? '저장 중…' : '완료'}</button>
      </div>
      <div ref={stageRef} className="img-editor-stage">
        {!img && !error && <span className="muted">불러오는 중…</span>}
        {img && (
          <div className={`img-editor-canvas mode-${mode}`} style={{ width: dw, height: dh }} data-testid="image-editor-canvas"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
            <canvas ref={canvasRef} />
            <div className="img-crop" style={{ left: c.x * scale, top: c.y * scale, width: c.w * scale, height: c.h * scale }} data-testid="image-editor-crop">
              {mode === 'crop' && handles.map((h) => <span key={h} className={`img-crop-h h-${h}`} data-handle={h} />)}
            </div>
          </div>
        )}
      </div>
      {error && <div className="img-editor-error error" role="alert">{error}</div>}
      <div className="img-editor-tools" role="toolbar" aria-label="편집 도구">
        <button type="button" className={`img-tool ${mode === 'crop' ? 'on' : ''}`} aria-label="자르기" aria-pressed={mode === 'crop'} disabled={!img} onClick={() => setMode('crop')}><CropIcon /><span>자르기</span></button>
        <button type="button" className={`img-tool ${mode === 'pen' ? 'on' : ''}`} aria-label="펜으로 표시" aria-pressed={mode === 'pen'} disabled={!img} onClick={() => setMode('pen')}><PenIcon /><span>펜</span></button>
        <button type="button" className="img-tool" aria-label="오른쪽으로 90도 회전" disabled={!img || busy} onClick={rotate}><RotateIcon /><span>회전</span></button>
        <button type="button" className="img-tool" aria-label="되돌리기" disabled={past.length === 0 || busy} onClick={undo}><UndoIcon /><span>되돌리기</span></button>
        {mode === 'crop' && (
          <div className="img-ratios" role="group" aria-label="자르기 비율">
            {([['free', '자유', '자유 비율'], ['original', '원본', '원본 비율'], ['square', '1:1', '1:1 정사각형']] as const).map(([r, label, aria]) => (
              <button key={r} type="button" className={`img-ratio ${snap.ratio === r ? 'on' : ''}`} aria-label={aria} aria-pressed={snap.ratio === r} disabled={!img || busy} onClick={() => pickRatio(r)}>{label}</button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
