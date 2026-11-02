import type { ResearchResponse } from '../../../shared/research-types';

export interface ResearchApi { get(): Promise<ResearchResponse> }

export const liveResearchApi: ResearchApi = {
  async get() {
    const response = await fetch('/api/hub/research', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(7_000), headers: { accept: 'application/json' } });
    if (response.status === 404) throw new Error('이 서버 빌드에는 아직 리서치 자료가 없습니다. 서버를 새 빌드로 올리면 보입니다.');
    if (!response.ok) throw new Error(`리서치 자료를 불러오지 못했습니다 (${response.status}).`);
    const body = await response.json() as Partial<ResearchResponse>;
    // A proxy or an older build can answer 200 with something else; one panel must not take the whole page down with it.
    if (!Array.isArray(body.articles) || !Array.isArray(body.sources) || !body.files || !body.skipped) throw new Error('서버 응답 형식이 리서치 자료와 맞지 않습니다. 서버 빌드를 확인하세요.');
    return body as ResearchResponse;
  },
};
