import { chat } from './chat';
import { common } from './common';
import { login } from './login';
import { settings } from './settings';
import { setup } from './setup';

/** The UI dictionary's source: ko must match its shape (tsc). */
export const en = { common, chat, setup, login, settings };
