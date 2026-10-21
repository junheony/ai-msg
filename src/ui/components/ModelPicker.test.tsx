// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CLAUDE_MODELS, CODEX_MODELS, GROK_MODELS } from '../../shared/models';
import { ModelMenu, modelLabel } from './ModelPicker';

function setup(extra: Partial<Parameters<typeof ModelMenu>[0]> = {}) {
  const onModel = vi.fn();
  const onEffort = vi.fn();
  render(<ModelMenu models={CLAUDE_MODELS} model="opus" effort="high" onModel={onModel} onEffort={onEffort} {...extra} />);
  return { onModel, onEffort };
}

describe('ModelMenu (the session sheet\'s model section)', () => {
  afterEach(cleanup);

  it('the chip label reads "<exact version>" + its effort (none while the effort is 자동 or unsupported)', () => {
    expect(modelLabel('opus', 'high')).toEqual({ name: 'Opus 5.5', effort: '높음' });
    expect(modelLabel('auto', null)).toEqual({ name: '자동', effort: null });
    expect(modelLabel('grok-4.5', 'xhigh').effort).toBeNull();
  });

  it('lists exact versions with descriptions, checks the current model and effort, and reports picks', () => {
    const { onModel, onEffort } = setup();
    const menu = within(screen.getByTestId('model-menu'));
    const models = within(menu.getByRole('group', { name: 'Claude' })).getAllByRole('menuitemradio');
    expect(models.map((b) => b.querySelector('.mp-name')?.textContent)).toEqual(['Sonnet 5.5', 'Opus 5.5', 'Fable 5.1']);
    expect(models.every((b) => (b.querySelector('.mp-desc')?.textContent ?? '').length > 0)).toBe(true);
    expect(models.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    // A single engine: no section header for it, but the effort section is headed.
    expect(menu.queryByText('Claude')).toBeNull();
    // Four levels are over the segment limit (3): a select after the menu, not menu items.
    expect(menu.queryByRole('group', { name: '추론 수준' })).toBeNull();
    const effort = screen.getByRole('combobox', { name: '추론 수준' }) as HTMLSelectElement;
    expect(Array.from(effort.options).map((o) => o.textContent)).toEqual(['낮음', '중간', '높음', '엑스트라']);
    expect(effort.value).toBe('high');
    fireEvent.click(menu.getByText('Fable 5.1'));
    expect(onModel).toHaveBeenCalledWith('fable');
    fireEvent.change(effort, { target: { value: 'xhigh' } });
    expect(onEffort).toHaveBeenCalledWith('xhigh');
  });

  it('auto engine: Claude and GPT sections with headers', () => {
    setup({ models: [...CLAUDE_MODELS, ...CODEX_MODELS], model: 'gpt-6-sol', effort: 'medium' });
    const menu = within(screen.getByTestId('model-menu'));
    expect(menu.getByText('Claude')).toBeTruthy();
    expect(within(menu.getByRole('group', { name: 'GPT' })).getAllByRole('menuitemradio').map((b) => b.querySelector('.mp-name')?.textContent)).toEqual(['GPT-6.1-Sol', 'GPT-6-Astra']);
  });

  it('자동: listed first, label without effort while effort is 자동, and an effort 자동 button reporting null', () => {
    const { onModel, onEffort } = setup({ models: ['auto', ...CLAUDE_MODELS], model: 'auto', effort: null });
    const menu = within(screen.getByTestId('model-menu'));
    const models = within(menu.getByRole('group', { name: 'Claude' })).getAllByRole('menuitemradio');
    expect(models.map((b) => b.querySelector('.mp-name')?.textContent)).toEqual(['자동', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.1']);
    const effort = screen.getByRole('combobox', { name: '추론 수준' }) as HTMLSelectElement;
    expect(Array.from(effort.options).map((o) => o.textContent)).toEqual(['자동', '낮음', '중간', '높음', '엑스트라']);
    expect(effort.value).toBe('');
    fireEvent.change(effort, { target: { value: 'low' } });
    expect(onEffort).toHaveBeenCalledWith('low');
    fireEvent.change(effort, { target: { value: '' } });
    expect(onEffort).toHaveBeenLastCalledWith(null);
    fireEvent.click(menu.getByText('Opus 5.5'));
    expect(onModel).toHaveBeenCalledWith('opus');
  });

  it('Grok: Grok 4.7 / 4.7 Fast / 4.6 / 4.5 with descriptions; Grok 4.5 offers no 엑스트라', () => {
    setup({ models: GROK_MODELS, model: 'grok-4.5', effort: 'high' });
    const menu = within(screen.getByTestId('model-menu'));
    const models = within(menu.getByRole('group', { name: 'Grok' })).getAllByRole('menuitemradio');
    expect(models.map((b) => b.querySelector('.mp-name')?.textContent)).toEqual(['Grok 4.7', 'Grok 4.7 Fast', 'Grok 4.6', 'Grok 4.5']);
    expect(models.every((b) => (b.querySelector('.mp-desc')?.textContent ?? '').length > 0)).toBe(true);
    const effort = within(menu.getByRole('group', { name: '추론 수준' }));
    expect(effort.getAllByRole('menuitemradio').map((b) => b.textContent)).toEqual(['낮음', '중간', '높음']);
  });
});
