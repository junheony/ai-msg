import { lazyNamed } from './lazyNamed';

// Heavy views stay out of the first chunk (the entry was over Vite's 500 kB warning).
// Tests resolve this module to lazyViews.sync.tsx so a click still finds the dialog on the same tick.

export const SettingsView = lazyNamed(() => import('./components/SettingsView').then((m) => m.SettingsView));
export const AuthTerminal = lazyNamed(() => import('./components/AuthTerminal').then((m) => m.AuthTerminal));
export const Highlights = lazyNamed(() => import('./components/Highlights').then((m) => m.Highlights));
export const UsageSheet = lazyNamed(() => import('./components/UsageSheet').then((m) => m.UsageSheet));
export const SetupWizard = lazyNamed(() => import('./components/SetupWizard').then((m) => m.SetupWizard));
export const CommandPalette = lazyNamed(() => import('./components/CommandPalette').then((m) => m.CommandPalette));
export const LayoutsDialog = lazyNamed(() => import('./components/LayoutsDialog').then((m) => m.LayoutsDialog));
export const SidePanel = lazyNamed(() => import('./components/SidePanel').then((m) => m.SidePanel));
export const CommanderSheet = lazyNamed(() => import('./components/CommanderSheet').then((m) => m.CommanderSheet));
export const ImageEditor = lazyNamed(() => import('./components/ImageEditor').then((m) => m.ImageEditor));
