# Naver 문서 → Tistory 미디어 본문

`build-post-with-media.mjs`는 2026-09-24 실제 이식 작업에서 사용한 **순수 변환 함수**입니다. 파일 읽기·로그인·업로드·발행을 수행하지 않습니다. 원래 PC의 절대 import를 pack 상대 경로로 바꿨습니다.

pack 폴더를 기준으로 사용하는 예:

```js
import { buildPostWithMedia } from './recipes/build-post-with-media.mjs';

const converted = buildPostWithMedia(document, {
  sourceUrl: originalPublicPostUrl,
  mediaBySha256: uploadedMediaBySha256,
});
// converted: { title, content, mediaCounts, captionCount, blocks }
// content는 승인된 publisher의 메모리 payload로 전달합니다.
```

- `document`: `{title, blocks}`. heading/paragraph/link/numbered/bulleted/table/image/video/notice/spacer를 처리합니다.
- `mediaBySha256`: source block hash → `{attachment,width,height}`의 Map 또는 객체. 업로드한 티스토리 결과를 사용합니다. 원본 네이버 주소를 hot-link로 바꾸는 함수가 아닙니다.
- 미디어 다음 paragraph의 `presentation:'caption'`은 캡션으로 옮겨 중복 본문 출력을 피합니다.
- 선택적인 `renderVideo({attachment,caption,width,height,sourceSha256})`가 HTML을 반환하면 인라인 플레이어 등 관측한 renderer를 적용할 수 있습니다. 기본값은 native file attachment이며 동영상 재생을 보장하지 않습니다.
- `sourceLogNo`는 당시 알려진 일부 문서의 legacy 캡션 보정에만 쓰입니다. 그 경로는 source hash·block index·정확한 문구까지 일치해야 하며, 임의의 다른 문서에 적용하지 않습니다.

attachment의 서명 URL이 `content`에 들어갈 수 있으므로 **실제 변환 content를 로그·Git·평문 영수증으로 저장하지 않습니다**. 작업 재개에 필요하면 승인된 보호 저장소에 저장하세요. 일반 증거에는 media/count/hash/캡션 대조 결과만 남깁니다.

실제 게시 단계는 [pack README](../README.md)의 관리 API 계약, 쓰기 저널 및 readback을 따릅니다. 과거 다섯 글의 고정 ID·절대경로·게시 manifest를 새 환경의 기본 실행값으로 복사하지 않았습니다.
