import type { Widen } from '../../../shared/locale';
import type { en } from '../en';
import { api } from './api';
import { cloud } from './cloud';
import { setup } from './setup';
import { turn } from './turn';

export const ko: Widen<typeof en> = { api, cloud, setup, turn };
