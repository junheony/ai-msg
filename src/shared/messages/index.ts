import { pick, type Widen } from '../locale';
import { en } from './en';
import { ko } from './ko';

export type SharedMessages = Widen<typeof en>;

/** The shared strings in the current locale. */
export const shared = (): SharedMessages => pick<SharedMessages>({ en, ko });
