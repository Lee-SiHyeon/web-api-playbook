# 프로필 조회·미리보기·편집

API-only 프로필 실행기는 현재 계정의 디자인을 읽고, 지정한 항목만 바꾼 전체 설정을 저장한다.
사용자가 지정하지 않은 기존 값과 `null`을 보존한다. 로그인은 기존 Inpock provider를 재사용한다.

```bash
# 승인된 공급자의 {username,password} JSON은 stdin에만 연결한다.
node scripts/inpock.mjs profile-get --credentials-stdin
node scripts/inpock.mjs profile-preview --input=PROFILE.json --credentials-stdin
node scripts/inpock.mjs profile-edit --input=PROFILE.json --credentials-stdin
```

`profile-get`은 현재 profile, `isDraft`, `snapshotHash`와 보호 owner 확인을 반환한다.
`profile-preview` 입력은 `{ownerUsername,changes}`이며 before/target/변경 필드를 반환하고 저장하지 않는다.
`profile-edit`은 해당 snapshot을 기준으로 다음 입력을 받는다.

```json
{
  "confirm": true,
  "ownerUsername": "<검증된 계정 이름>",
  "editId": "<이 수정 의도의 고정 ID>",
  "expectedSnapshotHash": "<profile-get 결과>",
  "changes": {
    "title": "<프로필 이름>",
    "bio": "<소개, 최대 60자>"
  }
}
```

이 입력 파일에는 자격정보를 넣지 않는다. 같은 수정을 재확인할 때 `editId`를 바꾸지 않는다.
새 기준 snapshot이나 새 ID를 만들어 미확정 결과를 우회하지 않는다.

## 지원 필드와 보존

제목(100자), 소개(60자), SNS, 프로필/커버 이미지 참조, SNS 위치, 레이아웃, 정렬,
글꼴·색상·블록 모양, 공지와 관측된 표시 옵션을 처리한다.
SNS는 관측된 `{type,value,order}` 형식을 사용한다.
새 이미지 파일 업로드는 아직 구현하지 않았으며 이미 현재 디자인에 있는 이미지 참조만 재사용한다.

서버는 `GET /v2/users/design`에 `{data,is_draft,history}`를 반환한다.
저장은 `POST /v2/users/design/save`에 전체 디자인 필드와 검증한 owner의 `user_id`를 보낸다.
브라우저 UI가 일부 `null`을 기본값으로 바꾸는 것과 달리, 이 클라이언트는 무관한 설정을 바꾸지 않도록
기존 raw `null`, 공지 ID와 내용, SNS 값을 유지한다.
새로 변경하는 값은 현재 알려진 선택지와 길이 제한을 검사한다.

기준 상태가 바뀌었거나 기존 초안이 있으면 저장하지 않는다. 초안 삭제·undo·redo를 자동으로 호출하지 않는다.
수정 의도를 owner/고정 editId 저널로 예약하고 POST를 한 번만 수행한다.
결과가 미확정인 이전 수정은 읽기 대사로만 확인하며 새 수정도 차단한다.
관리 설정 전체와 쿠키 없는 공개 profile의 변경 필드를 대조한다.
snapshot 비교는 클라이언트 사전 검사이며 서버의 원자적 compare-and-swap을 주장하지 않는다.

## 현재 검증 범위

실제 CLI로 보호 profile GET 200, 미리보기, 같은 소개 값을 다시 지정한 요청의
`status:"unchanged"`, `postAttempts:0`을 확인했다.
실제 새 프로필 값이 지정되지 않아 저장 POST는 실행하지 않았다.
따라서 서버의 저장 수락, legacy null을 포함한 전체 폼 수락, 저장 ACK 형식은 **미검증**이다.
이 상태는 체크리스트에서도 완료로 표시하지 않는다.

[실행 영수증](../verification/inpock-profile-2026-10-05.json)과 `npm run checklist`로 상태를 확인한다.
