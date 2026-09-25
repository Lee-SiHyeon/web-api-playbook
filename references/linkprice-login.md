# LinkPrice 웹 로그인 사용법

대상: `https://ac.linkprice.net/`의 기존 인플루언서 계정.
웹에서 관측한 `https://api.linkprice.com` 요청을 독립 HTTP로 실행한다.
정상 비밀번호 로그인, 입력 준비, 계정 확인, 등록 사이트 조회에 브라우저 엔진이 필요하지 않다.
첫 구현 때에는 웹 로그인/XHR를 관측했다. 이후 CLI 실행은 브라우저와 분리했다.

## 설치와 첫 연결

저장소 루트에서 Node.js 24 이상을 사용한다.

```powershell
npm ci --ignore-scripts
node scripts/web-login.mjs linkprice status
```

최초 자격 증명은 `node scripts/web-auth-import.mjs linkprice-login`의 **stdin**으로 전달한다.
JSON 형식은 `{username,password}`이며, 승인된 비밀 입력 공급자 또는 브라우저 관측기에서
child stdin으로 직접 보낸다. 비밀번호를 명령 인수, 환경변수, 파일, Git에 넣지 않는다.
이름만 저장됐다는 status 결과는 로그인 성공을 의미하지 않는다.

직접 처음 연결할 때는 PowerShell에서 다음을 실행한다. 비밀번호는 가려진 입력으로 받고
JSON은 파일 대신 자식 프로세스의 stdin으로 보낸다.

```powershell
$linkpriceUser = Read-Host 'LinkPrice ID'
$linkpriceSecret = Read-Host 'LinkPrice password' -AsSecureString
$linkpriceCredential = [pscredential]::new($linkpriceUser, $linkpriceSecret)
try {
    @{
        username = $linkpriceCredential.UserName
        password = $linkpriceCredential.GetNetworkCredential().Password
    } | ConvertTo-Json -Compress | node scripts/web-auth-import.mjs linkprice-login
} finally {
    $linkpriceCredential = $null
    $linkpriceUser = $null
    $linkpriceSecret.Dispose()
    $linkpriceSecret = $null
}
node scripts/web-login.mjs linkprice ensure
```

Windows DPAPI CurrentUser 저장 이름:

| 이름 | 내용 |
|---|---|
| `linkprice-login` | 계정 식별자와 비밀번호 |
| `linkprice-state` | origin에 한정된 Bearer·CSRF, 세션, 계정 식별자, 만료 힌트 |
| `linkprice-pending` | 로그인 시도 단계와 실패/대사 상태 |

위 값은 사용자 홈의 `.config/xhr-to-api-only/credentials`에 암호화해 저장한다.
Git clone이나 DPAPI 파일 복사는 다른 Windows 사용자/PC의 로그인을 이전하지 않는다.

## 반복 실행

```powershell
# 저장 세션 조회 → 만료 30초 전 또는 서버 401이면 비밀번호로 재로그인
node scripts/web-login.mjs linkprice ensure

# 새 HTTP 로그인 / 읽기만 하는 세션 확인 / 명시적인 새 토큰 발급
node scripts/web-login.mjs linkprice login
node scripts/web-login.mjs linkprice health
node scripts/web-login.mjs linkprice renew

# 현재 계정에 등록된 사이트 목록
node scripts/web-login.mjs linkprice sites

# 토큰만 갱신(비밀번호 없이) / 광고주 목록 / 광고주별 승인 상태 / 승인된 광고주의 트래킹 링크
node scripts/web-login.mjs linkprice refresh
node scripts/web-login.mjs linkprice merchants cps
'{"merchantIds":["gmarket","auction"]}' | node scripts/web-login.mjs linkprice subscriptions
'{"merchantId":"gmarket","targetUrl":"https://www.gmarket.co.kr/"}' | node scripts/web-login.mjs linkprice link
```

`ensure`는 만료 30초 전이거나 서버가 토큰 만료를 알리면 먼저 `PUT /svc/token/refresh`로 갱신하고, 서버가 갱신을 거절하면(최초 발급 3개월 경과 등) 비밀번호 로그인으로 넘어간다. `renew`는 비밀번호 로그인을 직접 호출한다.
서버 JWT의 `exp`는 재로그인 시점을 고르는 힌트다. JWT를 해석한 것만으로 인증되었다고 보지 않으며,
항상 보호된 계정 조회로 실제 소유자를 대조한다. 시간 버퍼 30초는 이 클라이언트의 정책이다.

성공 예시의 의미:

```json
{"authenticated":true,"ownerVerified":true,"browserUsed":false,"renewal":"stored_session"}
```

`login`의 `renewal`은 `password_login`이다. 실제 비밀번호·토큰·CSRF는 결과에 출력하지 않는다.
`sites`는 `sites:[{affiliateId,siteUrl}]`와 HTTP 영수증을 반환한다. 개인 계정의 조회 결과이므로 공유 범위를 주의한다.

## 기존 모노레포에서 사용

`affiliate-content-operations`와 이 저장소를 나란히 clone한다. 다른 배치라면
`WEB_API_PLAYBOOK_ROOT`에 이 저장소의 절대 경로를 지정한다.

```powershell
node apps/affiliate-api-hub/scripts/web-auth.mjs linkprice ensure
node apps/affiliate-api-hub/scripts/web-auth.mjs linkprice sites
npm run auth:status -w @affiliate-content-operations/affiliate-api-hub
```

프로그램에서는 `createLinkpriceAuth`를 사용한다.

```js
import { createLinkpriceAuth } from './lib/web-auth/linkprice.mjs';
const auth = createLinkpriceAuth();
const status = await auth.ensure();
const result = await auth.sites();
```

## 관측 계약

| 목적 | 요청 | 입력 | 응답/판정 |
|---|---|---|---|
| 로그인 | `PUT /svc/login` | JSON `dom:"AC",id,pw` | `success,message,token,csrf,name`; `success=true` 및 토큰 형식 확인 |
| 계정 대조 | `PUT /svc/query` | `orm_key:"dc_lpop/taccount/v1/GetAccount"`, `input:{acc_id}`, `columns:["account_id"]` | `account_id`가 설정 계정과 일치해야 함 |
| 토큰 갱신 | `PUT /svc/token/refresh` | 본문 없음, 현재 Bearer | `{tkn}` 새 토큰(CSRF 유지). 거절 시 `{code,msg}` (예: 최초 발급 3개월 경과) |
| 광고주 목록 | `PUT /svc/query` | `orm_key:"dc_lpop/tmerchant/v1/GetMerchants"`, `input:{hidden_flag:"N",max_pgm_std_end_date:오늘,is_cps:true,orderby}` | NDJSON 행. CLI는 공개 광고주 필드만 투영 |
| 광고주별 승인 상태 | `PUT /svc/query` | `orm_key:"dc_lpop/tsubscript/v1/GetSubscript"`, `input:{aff_id,mer_id}` (mer_id 필수) | `subs_status` APR 승인·REQ 신청·DEN 거절, `ErrNoRows`=미신청 |
| 등록 사이트 조회 | `PUT /svc/query` | `orm_key:"dc_lpop/taffiliate/v1/GetAffiliates"`, `input:{account_id}`, `columns:["affiliate_id","site_url"]` | 관측된 단일 사이트 응답은 배열이 아닌 객체. CLI는 목록으로 정규화 |

`/svc/query` 응답은 **NDJSON**(한 줄에 JSON 한 행)이다. 행이 하나면 객체 하나로 보인다.
만료·무효 토큰은 401이 아니라 **HTTP 200 `{error_code, error_message:"Token is expired"}`**로 온다(2026-09-25 관측). 클라이언트는 이를 재인증 신호로 분류하고, `ErrNoRows`는 빈 결과로 다룬다.

트래킹 링크는 API가 아니라 웹 앱이 직접 조립한다(번들의 `getClickUrl`): `https://click.linkprice.com/click.php?m=<광고주>&a=<사이트ID>&l=9999&l_cd1=3&l_cd2=0&tu=<URL 인코딩한 대상>`. `link` 명령은 승인(APR)된 광고주에만 링크를 만든다.
계정 쓰기 두 가지는 사용자가 명시적으로 요청할 때만 실행한다. 둘 다 전송 전에 저널(`<보호 저장소>/journal/linkprice`)을 예약하고, 한 번만 보내며, 응답 뒤 독립 조회로 확인한다. 같은 의도의 저널이 이미 있으면 다시 보내지 않고 조회로 대사한다.

| 목적 | 요청 | 입력 |
|---|---|---|
| 광고주 승인 신청 | `PUT /svc/query` `dc_lpop/tsubscript/v1/Create` | `{affiliate_id, merchant_id, subs_status}` — 웹 앱과 같이 기존 APR/REQ/DEN이면 건너뛰고, `GetMerchant.approval_type`이 AUT이면 APR, 아니면 REQ. `apply`는 기본적으로 AUT만 신청 |
| 웹사이트 등록 | `PUT /svc/query` `dc_lpop/taffiliate/v1/Create` | `{account_id, site_type:"W", site_name, kc_category1, kc_category2, site_desc, mer_forwarding_yn:"S", merchant_error_url:"", site_url, rec_category1..3:"", delete_flag:"N"}` — 카테고리는 `tcode GetCodes`의 ACTIVITY_CATE(912 티스토리 블로그 등)·CONTENTS_CATE(914 특가·이벤트 등) |

```powershell
'{"siteName":"...","siteUrl":"https://example.tistory.com","category1":"912","category2":"914","siteDesc":"..."}' | node scripts/web-login.mjs linkprice add-site
'{"merchantIds":["gmarket","auction"],"affiliateId":"A100708029"}' | node scripts/web-login.mjs linkprice apply
```

사이트가 둘 이상이면 `subscriptions`·`link`·`apply`에 `affiliateId`를 지정해야 한다(승인 상태와 링크는 사이트별).

`/svc/query`의 HTTP 메서드는 PUT이지만 위 두 operation의 의미는 조회다.
임의 ORM selector, 계정 변경, 커미션 인출 등 쓰기 operation은 실행기에 노출하지 않았다.

인증 헤더는 `Authorization: Bearer <token>`, `X-CSRF-Token: <csrf>`이다.
관측한 로그인 응답에는 쿠키가 없었다. 발급된 토큰과 CSRF를 API origin에만 전달한다.
사용자 정보 전체를 조회하지 않고, 계정 대조는 `account_id` 하나만 요청한다.

이 서비스의 실제 MIME은 **`text/html; charset=UTF-8`이지만 본문은 JSON**이다.
JSON MIME만 허용하던 초기 구현의 오분류를 수정했다. `text/html`을 받아도 JSON 해석과 정확한 응답 스키마,
계정 대조를 모두 통과해야 한다. 로그인 HTML이나 임의의 HTTP 200 응답은 성공으로 인정하지 않는다.

## 실패와 재개

| 코드 | 처리 |
|---|---|
| `LOGIN_INPUT_MISSING` | 위 stdin 경로로 최초 자격 증명 연결 |
| `SESSION_MISSING` | `ensure` 또는 `login` 실행 |
| `LOGIN_REJECTED` | 서버가 로그인 실패를 명시. 입력/계정 상태 확인 |
| `AUTH_FORBIDDEN`, `AUTH_THROTTLED` | 권한·차단·요청 제한 경계. 비밀번호 재시도 루프를 돌리지 않음 |
| `AUTH_OUTCOME_UNKNOWN` | 전송 결과가 모호한 시도를 pending에 보존. 다음 실행도 자동 재전송하지 않음 |
| `OWNER_MISMATCH` | 저장/입력 계정과 보호 조회가 다름. 업무 조회 진행하지 않음 |
| `OWNER_SCHEMA_INVALID`, `SITES_SCHEMA_INVALID` | 실제 응답 계약이 달라짐. body를 출력하지 않고 재관측 |

이미 발급된 동일 계정의 토큰을 확보한 경우 `{token,csrf}`를
`node scripts/web-login.mjs linkprice import-tokens` stdin으로 전달할 수 있다.
보호된 계정 대조 성공 뒤에만 저장하며, 모호했던 시도는 대사 근거와 함께 보존한다.
정상 루틴에서는 이 import나 브라우저 캡처가 필요 없다.

## 2026-09-24 실행 증거

- 브라우저 정상 로그인과 실제 `PUT /svc/login` 요청 관측.
- 새 Node 프로세스에서 저장 비밀번호로 로그인, Bearer·CSRF 발급, 최소 필드 계정 대조 성공.
- 별도의 새 Node 프로세스가 DPAPI 세션을 읽어 `stored_session`으로 계정 대조 성공.
- 실제 모노레포 실행기로 등록 사이트 1개 조회 성공.
- 실제 서버 만료 시각까지 기다린 만료 복구, 서버 강제 폐기 후 복구, OTP/CAPTCHA 분기는 미관측.
  현재 정상 계정의 로그인에는 추가 챌린지가 없었다.

기계 판독 기록: [linkprice-login-2026-09-24.json](../verification/linkprice-login-2026-09-24.json).
