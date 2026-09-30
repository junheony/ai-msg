// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AttachmentBar } from './AttachmentBar';

describe('AttachmentBar (D7)', () => {
  afterEach(cleanup);

  it('lists chips with remove buttons, shows upload progress and errors, and forwards picked files', () => {
    const onRemove = vi.fn();
    const onFiles = vi.fn();
    render(<AttachmentBar attachments={[{ id: '1', name: 'shot.png', size: 2048, isImage: true }, { id: '2', name: 'notes.md', size: 10, isImage: false }]} uploading={1} error="업로드 실패" onFiles={onFiles} onRemove={onRemove} />);
    expect(screen.getByText(/shot\.png/).textContent).toContain('🖼');
    expect(screen.getByText(/notes\.md/).textContent).toContain('📄');
    expect(screen.getByText('업로드 중 1')).toBeTruthy();
    expect(screen.getByText('업로드 실패')).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText('첨부 제거')[0]!);
    expect(onRemove).toHaveBeenCalledWith('1');
    const input = screen.getByTestId('attachment-input') as HTMLInputElement;
    const f = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [f] } });
    expect(onFiles).toHaveBeenCalledWith([f]);
  });
});
