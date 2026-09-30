/** Claude Code's project directory name: every non-alphanumeric code unit → '-'. NFC and NFD spellings differ. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
