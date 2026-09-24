# 쓰기 의도, 결과 불명확, 대사

## 먼저 남길 것

쓰기 전에 사용자가 지정한 서비스·대상·내용을 확정하고, 요청의 안정된 fingerprint를 계산합니다. 출력 파일을 생성할 수 있는지 먼저 확인한 뒤 저널을 `wx`로 예약합니다. 이 순서이면 기존 결과 파일 충돌 때문에 쓰기가 재실행되지 않습니다.

이 패키지의 `request.mjs`는 service/operation, URL과 body의 hash로 의도를 식별합니다. 세션 token이나 일회용 실행 ID를 재시도 키로 쓰지 않습니다. 원문 URL/body/인증값은 저널에 들어가지 않습니다.

## 상태별 다음 작업

| 상태 | 의미 | 다음 작업 |
|---|---|---|
| `reserved` | 전송 직전 의도 저장됨. 프로세스가 여기서 끊겨도 결과는 아직 모름 | 독립 조회로 확인 |
| `finished` + `acknowledged_requires_readback` | 예상한 HTTP/application ACK 수신 | 정확한 대상 readback 대조 |
| `needs-reconciliation` | 응답 전/검증 중 오류 또는 대사 불명확 | 같은 저널과 대상·관리 목록 확인 |
| `reconciled` + `found` | 호출자가 제공한 readback상 대상을 찾음 | 내용/공개/소유자까지 필요한 검증 완료 |
| `reconciled` + `not-found` | 제공된 조회 범위에서 부재 확인 | 조회 완전성을 판단한 후 별도 재시도 결정 |

`reconcile`는 호출자가 넘긴 증거를 기록하는 함수입니다. 직접 HTTP를 보내지 않으며 `found`를 자동 사실 검증하지도 않습니다. `not-found`여도 새 POST를 보내지 않습니다. 새로운 시도가 필요하면 이전 저널을 보존하고 그 대사 영수증을 연결한 명시적 attempt를 서비스 adapter에서 만드세요. API 호출자가 삭제/키 변경으로 이 보호를 우회하면 저널의 의미가 없어집니다.

## 라이브러리 예시

```js
import { WriteJournal } from '../lib/write-journal.mjs';
const journal = new WriteJournal({ root: './work/journal', service: 'example' });
const previous = await journal.read('EXISTING_64_HEX_KEY');
// Same account + complete relevant list + exact target/content comparison first.
await journal.reconcile(previous.key, {
  result: 'found',
  independentRead: true,
  ownerMatched: true,
  contentMatched: true,
  evidenceRef: 'readback-002',
});
```

실제 hash 키와 독립 readback 결과로 바꿔야 합니다. 예시는 대사를 수행한 척하는 자동 코드가 아닙니다. 정상 ACK 후 readback뿐 아니라 응답을 못 받은 쓰기에도 같은 원칙을 적용합니다.

## 세션에서 얻은 교훈

- 티스토리에서는 POST가 0.3초 만에 예외를 던졌어도 전송 전인지 응답 유실인지 시간만으로 확정할 수 없었습니다. 관리 목록의 전체 관련 범위를 읽고 대상 미생성을 확인한 뒤 재시도를 판단했습니다.
- POST body의 `id` 존재는 update 증거가 아닙니다. 해당 서비스에서 관측된 PUT/POST 차이를 보존합니다.
- 업로드 성공 후 발행 실패라면 미디어 저널과 발행 저널을 따로 재개합니다. 이미 올린 파일을 매번 재업로드하지 않습니다.
- HTTP 오류 뒤 cookie rotation을 무조건 버리면 다음 작업이 오래된 세션으로 실행될 수 있습니다. 신뢰한 origin에서 받은 변경만 저장하고 다음 보호 조회에서 재확인합니다.
- `writeStarted` 이후 저장소/출력 장애도 대사 대상으로 보수적으로 보고합니다. 서버 성공을 로컬 기록 실패로 재전송하지 않습니다.

이 generic journal은 로컬 파일 원자성과 중복 의도 차단을 제공합니다. 서버의 idempotency 보장은 아닙니다. 결제·삭제·게시 등 실제 결과 검증은 서비스별 계약에서 정해야 합니다.
