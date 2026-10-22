import type { Widen } from '../../../shared/locale';
import type { en } from '../en';
import { setup } from './setup';
import { turn } from './turn';

export const ko: Widen<typeof en> = { setup, turn };
