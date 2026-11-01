import type { LabResponse } from '../../../shared/lab-types';
export interface LabApi { summary(): Promise<LabResponse> }
export const liveLabApi: LabApi = {
  async summary() {
    const response = await fetch('/api/hub/lab', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(7_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`요약 요청 실패 (${response.status})`);
    return response.json() as Promise<LabResponse>;
  },
};
