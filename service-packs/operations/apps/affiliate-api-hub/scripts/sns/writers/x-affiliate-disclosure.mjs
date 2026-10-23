const AFFILIATE_LINK = /https?:\/\/(?:[\w-]+\.)*(?:link\.coupang\.com|coupa\.ng|linkprice\.com|lpweb\.kr|myrealt\.rip)\b/i;
const COUPANG_LINK = /https?:\/\/(?:link\.coupang\.com|coupa\.ng)\b/i;
export const COUPANG_DISCLOSURE = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Check the whole publication before reserving a write or uploading media.
// A separately sent affiliate reply must supply its already verified main text.
export function assertXAffiliateDisclosure(posts, { affiliateReply, replyToId, mainText } = {}) {
  const planned = [...posts, ...(affiliateReply ? [affiliateReply] : [])];
  if (!planned.some(text => AFFILIATE_LINK.test(text))) return;
  const main = replyToId ? mainText : posts[0];
  if (typeof main !== 'string' || !main.includes('광고')
    || !/^(?:광고(?:\s|·)|#광고(?:\s|$))/.test(main.trimStart())) fail('X_AFFILIATE_MAIN_DISCLOSURE_REQUIRED');
  const replies = replyToId ? posts : [...posts.slice(1), ...(affiliateReply ? [affiliateReply] : [])];
  for (const reply of replies) {
    if (COUPANG_LINK.test(reply) && !reply.trimStart().startsWith(COUPANG_DISCLOSURE + '\n')) {
      fail('X_COUPANG_REPLY_DISCLOSURE_REQUIRED');
    }
  }
  if (COUPANG_LINK.test(main) && !main.includes(COUPANG_DISCLOSURE)
    && !replies.some(reply => reply.trimStart().startsWith(COUPANG_DISCLOSURE + '\n'))) {
    fail('X_COUPANG_REPLY_DISCLOSURE_REQUIRED');
  }
}
