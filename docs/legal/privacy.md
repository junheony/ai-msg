# AI-MSG Privacy Policy

> **DRAFT. Not legal advice. A lawyer must review this before payments go live.**
> 초안 — 법률 자문 아님, 결제 개시 전 변호사 검토 필요
> Effective date: `{{EFFECTIVE_DATE}}`
> If this document and its Korean translation differ, this English original controls `{{확인 필요: 준거 언어 조항 — 변호사 확인}}`.

`{{OPERATOR_NAME}}` of `{{ADDRESS}}` ("we") operates AI-MSG. Contact: `{{CONTACT_EMAIL}}`. This policy covers three things: the local app, the Pro Cloud, and payments.

## Summary

- The local app stores everything on your device. It sends nothing to us. Local push notifications go straight from your computer to your browser's push service (see section 1).
- Pro Cloud holds your account email, device and pairing information, and push subscriptions. It cannot read your messages, because they are end-to-end encrypted.
- Paddle handles payments. We never receive your card number.
- We never access your AI vendor credentials.

## 1. Local app

The local app runs on your computer. It stores its data on your device only. We do not receive it.

**Files the app reads.** AI-MSG reads these so it can show your sessions and usage:

| What | Why |
|---|---|
| Conversation transcripts that the Vendor Tools keep (for example under each Claude profile folder and the Codex sessions folder) | To list your sessions and show history |
| Folders you choose to work in | To run the Vendor Tools there and preview files |
| Usage figures the Vendor Tools print during a turn | To show remaining limits |
| Codex session files (rollouts), for usage display. This cannot be turned off | To show remaining Codex limits |
| Grok CLI session folder. There is no switch for this | To list and continue Grok sessions |
| The list of running processes on your computer (`ps`) | To tell whether another process is holding a session |

The app does not read vendor sign-in tokens, key files or keychains. For Gemini it runs the official tool's status command (`agy models`) and looks only at the exit code to see whether you are signed in. It does not read any credential.

**Usage checks.** In the background, AI-MSG periodically runs the official tools' own usage commands: for Claude `claude -p /usage` every 5 minutes, for Gemini `agy /usage`, and for Grok the official CLI's billing query. Those tools talk to their vendor with your own sign-in. AI-MSG does not read or receive that sign-in.

**Files the app writes.** Its own settings, session state, an audit log of permission decisions, highlights (kept 7 days), uploaded attachments (deleted after 7 days), push keys and usage aggregates, all in its own configuration folder on your device.

**Reading other apps' local files.** Some features read local files of other apps. On a new install, the Grok Bot and Claude Desktop features are off. Reading Codex sessions and Antigravity summaries is on by default, and you can turn it off in Settings. Reading Codex session files for the usage display cannot be turned off. Installs upgraded from an earlier version keep the earlier behavior, with all three switches on. When a switch is off, those files are not read. The app opens other apps' databases only as temporary copies, and does not write to their folders, except where the setting for mirroring sessions says so `{{확인 필요: 실험 기능별 읽기·쓰기 범위 최종 목록(제품 확정 후)}}`.

**Local push.** If you use push without Pro Cloud, your computer sends notifications directly to your browser's push service (run by Google, Mozilla, Apple or Microsoft) and keeps the subscription in its own folder. That service sees that a push was sent and the VAPID subject, which is your computer's Tailscale name. The content is encrypted for your device. Local push text can include the session title, the first line of the AI's reply, and the name and a short description of the tool asking for permission. For a shell tool, that can be the command.

## 2. Pro Cloud

Pro Cloud exists only if you sign in and link a device.

**Data we hold**

| Data | Purpose |
|---|---|
| Account email, creation time | Sign-in by email link, billing match, trial limit of once per email |
| Sign-in link and web session records (stored as hashes) | Authentication |
| Computer name, public key, link time | Device registration |
| Paired phone or browser name, public key, state, last-seen time | Pairing and relay access |
| Pairing attempt records | Secure pairing |
| Trial start and end times | Trial |
| Subscription status, plan, billing period, cancel state, Paddle customer and subscription IDs, refund status | Entitlement (what Pro features you may use) |
| Paddle webhook event records | Billing sync and duplicate protection |
| Hash of each push endpoint you register | Check that a push request is yours |
| Rate-limit counters (keyed by email or IP address) | Abuse protection |
| Operational logs: event type, device IDs, byte counts. No message content | Running and securing the service `{{확인 필요: 로그에 IP 주소가 남는지, 보관 기간}}` |
| Emails we send you (sign-in links) | Delivery `{{확인 필요: 메일 발송 업체와 발송 기록 보관}}` |

**What we cannot see.** Session content, prompts, code and AI output pass through the relay as encrypted data. The keys exist only on your paired devices. We cannot decrypt them. We do not store them.

**Push notifications.** To send a push, your computer encrypts the notification, and the cloud signs and forwards it to your browser's push service (for example the one run by your browser vendor). What a cloud push contains is not yet settled `{{확인 필요: 클라우드 경유 푸시 payload 내용 — 계획은 세션 제목·종류만이나 로컬 푸시는 답 첫 줄·도구 설명도 포함}}`. We keep a hash of your push endpoint, not the endpoint itself `{{확인 필요: 푸시 구독 전문을 클라우드가 저장하는지}}`.

**Service providers.** We use infrastructure and email providers to run Pro Cloud `{{확인 필요: 호스팅·메일 업체 이름과 서버 지역}}`. Your browser's push service sees that a push was sent to your device.

**Retention.** We keep account data while your account exists. Short-lived records, such as sign-in links and pairing attempts, expire on their own `{{확인 필요: 만료 기간과 정리 주기}}`. After you delete your account we remove your data `{{확인 필요: 삭제 기한}}`, except what the law requires us to keep, such as billing records `{{확인 필요: 법정 보관 기간}}`.

**Your rights and deletion.** You can ask us to access, correct, export or delete your data, and to close your account, by writing to `{{CONTACT_EMAIL}}`. You can unlink a computer or phone at any time in the app. `{{확인 필요: 적용 법령(GDPR·CCPA·한국 개인정보 보호법 등)별 권리·고지 문구}}`

**International transfers.** `{{확인 필요: 국외 이전 여부와 근거}}`

## 3. Payments

Paddle is the Merchant of Record. Paddle collects and processes your payment details, taxes and invoices under its own privacy policy. **We do not receive or store your card number.** We receive from Paddle your customer ID, subscription status and related billing events. `{{확인 필요: Paddle 이 우리에게 넘기는 정보 범위(이메일·국가 등)}}`

## 4. Vendor credentials

We never access your AI vendor credentials. AI-MSG does not read, store or forward sign-in tokens or API keys for Anthropic, OpenAI, Google, xAI or any other vendor. You sign in to the official tools yourself. Your use of those tools is governed by each vendor's own privacy policy.

## 5. Other points

- **No sale of data.** We do not sell your personal data.
- **Analytics and error reports.** `{{확인 필요: 분석·오류 리포트 수집 여부 — 계획 문서는 옵트인 정책 미정}}`
- **Cookies.** The local app uses a sign-in cookie on your device. Pro Cloud uses a session cookie for your account `{{확인 필요: 쿠키 목록}}`.
- **Children.** AI-MSG is not meant for children `{{확인 필요: 연령 기준}}`.
- **Changes.** We will post updates here and change the effective date. For material changes we will tell you `{{확인 필요: 통지 방법}}`.

## 6. Contact

`{{OPERATOR_NAME}}`, `{{ADDRESS}}`, `{{CONTACT_EMAIL}}`.
