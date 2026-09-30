// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsagePanel } from './UsagePanel';
import type { UsageSnapshot } from '../../shared/usage-types';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const usage: UsageSnapshot = {
  generatedAt: 'x',
  deckReachable: false,
  accounts: {
    a: { status: 'stale', fetchedAt: null, fiveHour: { usedPct: 13, resetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString() }, weekly: { usedPct: 7, resetsAt: null }, fable: { usedPct: 0, resetsAt: null } },
    b: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 82, resetsAt: null }, weekly: { usedPct: 3, resetsAt: null }, fable: null },
    c: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 0, resetsAt: null }, weekly: { usedPct: 96, resetsAt: null }, fable: { usedPct: 27, resetsAt: null } },
  },
};

describe('UsagePanel', () => {
  it('shows remaining % per window, warn/danger classes, current highlight, countdown, stale tag', () => {
    render(<UsagePanel usage={usage} current="b" now={NOW} />);
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('87%');
    expect(screen.getByTestId('a-fiveHour').textContent).toContain('2시간 30분');
    expect(screen.getByTestId('b-fiveHour').className).toContain('warn');
    expect(screen.getByTestId('c-weekly').className).toContain('danger');
    expect(screen.getByTestId('b-fable').textContent).toContain('—');
    expect(screen.getByTestId('account-b').className).toContain('current');
    expect(screen.getByTestId('account-a').className).not.toContain('current');
    expect(screen.getByText('오래된 값')).toBeTruthy();
  });

  it('renders a placeholder without data', () => {
    render(<UsagePanel usage={null} current={null} />);
    expect(screen.getByText('잔여량 불러오는 중…')).toBeTruthy();
  });
});
