/** The one place the install lines live (with README): if the npm name changes, change these. */
export const INSTALL_COMMAND = 'npx ai-msg';
export const GLOBAL_INSTALL_COMMAND = 'npm i -g ai-msg';
/** `ai-msg service install` (src/server/cli/args.ts SERVICE_ACTIONS): launchd on macOS, a systemd user unit on Linux. */
export const SERVICE_INSTALL_COMMAND = 'ai-msg service install';
export const REPO_URL = 'https://github.com/junheony/ai-msg';
