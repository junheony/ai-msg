import { describe, expect, it } from 'vitest';
import { stripImagePlaceholders } from './imagePlaceholder';

describe('stripImagePlaceholders', () => {
  it('drops lines that are only image placeholders and counts them', () => {
    expect(stripImagePlaceholders('이건 뭐야\n[이미지]')).toEqual({ text: '이건 뭐야', images: 1 });
    expect(stripImagePlaceholders('보완해보자\n[이미지]\n[이미지]\n[이미지]\n[이미지]\n[이미지]')).toEqual({ text: '보완해보자', images: 5 });
  });
  it('knows the English and Claude Code forms, several on one line', () => {
    expect(stripImagePlaceholders('[Image]\nlook')).toEqual({ text: 'look', images: 1 });
    expect(stripImagePlaceholders('[Image #1] [Image #2]\nthese')).toEqual({ text: 'these', images: 2 });
  });
  it('leaves a placeholder inside a sentence, and text without any, untouched', () => {
    expect(stripImagePlaceholders('see [이미지] above')).toEqual({ text: 'see [이미지] above', images: 0 });
    expect(stripImagePlaceholders('[link](x)')).toEqual({ text: '[link](x)', images: 0 });
  });
  it('a message of images only has no text left', () => {
    expect(stripImagePlaceholders('[이미지]\n[이미지]')).toEqual({ text: '', images: 2 });
  });
  it('inside a code fence nothing is hidden or folded; outside it still is', () => {
    const fenced = '```\n[이미지]\n\n\n\nx\n```';
    expect(stripImagePlaceholders(fenced)).toEqual({ text: fenced, images: 0 });
    expect(stripImagePlaceholders(`봐 줘\n[이미지]\n\n\n${fenced}\n[이미지]`)).toEqual({ text: `봐 줘\n\n${fenced}`, images: 2 });
    expect(stripImagePlaceholders('~~~\n[Image #1]\n```\n[이미지]\n~~~\n[이미지]')).toEqual({ text: '~~~\n[Image #1]\n```\n[이미지]\n~~~', images: 1 });
  });
});
