import type { LoginState } from '../setup-types';

// Strings both the UI and the server show (i18n plan ③). The source: ko.ts must have the same shape.

export const en = {
  loginState: { yes: 'Logged in', no: 'Not logged in', unknown: 'Unknown' } satisfies Record<LoginState, string>,
};
