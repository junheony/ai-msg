// Vitest stand-in for lazyViews.tsx: the same components, already loaded, so tests that open a
// dialog on the same tick as the click keep working. The production bundle does not import this file.
export { SettingsView } from './components/SettingsView';
export { AuthTerminal } from './components/AuthTerminal';
export { Highlights } from './components/Highlights';
export { UsageSheet } from './components/UsageSheet';
export { SetupWizard } from './components/SetupWizard';
export { CommandPalette } from './components/CommandPalette';
export { LayoutsDialog } from './components/LayoutsDialog';
export { SidePanel } from './components/SidePanel';
export { CommanderSheet } from './components/CommanderSheet';
export { ImageEditor } from './components/ImageEditor';
