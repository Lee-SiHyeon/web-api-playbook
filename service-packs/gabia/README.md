# Gabia domain and DNS pack

이 pack은 가비아 도메인의 **공개 DNS와 HTTPS 상태를 읽고**, 검토 가능한 DNS 입력 계획을 만듭니다. 공개 확인은 고정된 Google과 Cloudflare DNS-over-HTTPS 주소만 호출합니다. DNS 입력 계획은 로컬에서 만들며 가비아 로그인이나 변경 요청을 수행하지 않습니다.

## 현재 계약 상태

- 공개 DNS 확인: 구현됨. A, AAAA, CNAME을 두 공개 재귀 resolver에 질의하며 TTL 값은 감소할 수 있어 레코드 일치 비교에서 제외합니다. 이 결과는 권한 DNS 서버를 직접 질의했다는 증거가 아닙니다.
- HTTPS 확인: 구현됨. 기본 Node TLS 검증을 유지하고 apex 또는 `www`에서만 확인합니다. 리디렉션도 해당 두 호스트 안에서만 따라갑니다. 응답 본문은 읽지 않습니다.
- 입력 계획: A, AAAA, CNAME, MX, TXT 입력의 형식·TTL·중복·CNAME 충돌을 로컬에서 검사합니다.
- Google 로그인과 인증된 가비아 DNS 읽기: 별도 읽기 전용 adapter가 처리합니다. 로그인, 메모리 내 세션 전달과 검증된 GET 계약은 [인증된 DNS 읽기 playbook](../../references/gabia-login-dns.md)을 참고하세요. 이 public checker는 그 세션을 사용하지 않습니다.
- 가비아 DNS 쓰기: 구현하지 않았습니다. 관찰한 쓰기 요청과 독립 read-back 계약이 확인되기 전에는 실행 경로가 없습니다.

## Lifehack AILab 예시

```sh
node scripts/gabia.mjs status
node scripts/gabia.mjs prepare --input=examples/gabia/lifehackailab-records.json
node scripts/gabia.mjs verify --input=examples/gabia/lifehackailab-records.json
```

확인할 입력 계획은 아래 세 레코드입니다.

| 타입 | 호스트 | 값 | TTL |
| --- | --- | --- | ---: |
| A | `@` | `216.150.1.1` | 600 |
| A | `@` | `216.150.16.1` | 600 |
| CNAME | `www` | `f2b6c708ceb0ac50.vercel-dns-016.com.` | 600 |

`verify`는 public DNS에서 두 재귀 resolver가 같은 레코드를 확인하는지와 HTTPS 응답을 확인합니다. 권한 DNS와 Gabia 인증 화면은 이 명령의 조회 대상이 아닙니다. 필요하면 `--url=https://www.lifehackailab.com/`으로 HTTPS 대상을 지정할 수 있습니다. `SERVFAIL`, 시간 초과, resolver 간 차이는 레코드 불일치와 따로 보고하므로 전파 지연이나 resolver 장애를 잘못된 설정으로 단정하지 않습니다. 실제 Gabia 화면에 저장된 값을 읽었다는 뜻은 아니며, 어떤 명령도 DNS를 바꾸지 않습니다.

## 공개 확인 스냅샷

2026-10-08 KST public DNS 확인에서 Google과 Cloudflare가 apex의 두 A 레코드와 `www` CNAME을 모두 반환했습니다. Node HTTPS 확인은 apex와 `www` 모두 HTTP 429를 받았습니다. TLS 검증 오류는 관측되지 않았고 DNS 레코드 판정과 HTTPS 응답 상태는 별도로 기록했습니다. HTTP 429의 원인은 이 probe만으로 단정하지 않습니다. [원본 공개 조회 결과](../../sanitizedverification/gabia-public-domain-check-2026-10-08.json)와 [계정 인증 DNS 읽기 결과](../../sanitizedverification/gabia-authenticated-read-2026-10-08.json)를 함께 확인하세요.
