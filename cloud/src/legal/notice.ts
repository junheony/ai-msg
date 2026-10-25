/** The non-affiliation notice (launch check L10): the footer of every app page, `/legal/notice` and `/legal/ko/notice`. */
export const NOTICE = {
  en: 'AI-MSG is an independent product. It is not affiliated with, endorsed by or sponsored by Anthropic, OpenAI, Google or xAI. Product names such as Claude, Codex, Gemini and Grok belong to their owners. AI-MSG runs the official tools you install and sign in to yourself; it does not sell or resell AI usage.',
  ko: 'AI-MSG 는 독립 제품입니다. Anthropic·OpenAI·Google·xAI 와 제휴하거나 그들의 보증·후원을 받지 않습니다. Claude·Codex·Gemini·Grok 등의 이름은 각 소유자의 것입니다. AI-MSG 는 사용자가 직접 설치하고 로그인한 공식 도구를 실행할 뿐, AI 사용을 판매·재판매하지 않습니다.',
} as const;

/** The footer line: the first two sentences (independent, not affiliated); the rest is one click away. */
export const NOTICE_SHORT = {
  en: 'AI-MSG is an independent product, not affiliated with, endorsed by or sponsored by Anthropic, OpenAI, Google or xAI.',
  ko: 'AI-MSG 는 독립 제품이며 Anthropic·OpenAI·Google·xAI 와 제휴하거나 그들의 보증·후원을 받지 않습니다.',
} as const;
