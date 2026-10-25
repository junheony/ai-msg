import type { Widen } from '../../../shared/locale';
import type { en } from '../en';
import { cards } from './cards';
import { chat } from './chat';
import { common } from './common';
import { home } from './home';
import { login } from './login';
import { panels } from './panels';
import { settings } from './settings';
import { sessionIcon } from './sessionIcon';
import { setup } from './setup';
import { tool } from './tool';

export const ko: Widen<typeof en> = { common, chat, setup, login, settings, sessionIcon, cards, tool, panels, home };
