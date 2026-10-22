import type { Widen } from '../../../shared/locale';
import type { en } from '../en';
import { common } from './common';
import { login } from './login';
import { settings } from './settings';
import { setup } from './setup';

export const ko: Widen<typeof en> = { common, setup, login, settings };
