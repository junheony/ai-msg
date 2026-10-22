import type { Widen } from '../../../shared/locale';
import type { en } from '../en';
import { api } from './api';
import { setup } from './setup';
import { turn } from './turn';

export const ko: Widen<typeof en> = { api, setup, turn };
