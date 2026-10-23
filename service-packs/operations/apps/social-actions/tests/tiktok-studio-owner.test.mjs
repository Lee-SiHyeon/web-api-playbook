import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTikTokStudioOwner } from '../providers/tiktok.mjs';
test('current PascalCase Studio identity is verified independently of display name', () => {
  const payload = { statusCode: 0, userBaseInfo: { UserProfile: { UserBase: { Id: '12345678901234567', UniqId: 'lifehack__aibal', NickName: 'different display name' } } } };
  assert.equal(verifyTikTokStudioOwner(payload), true);
  payload.userBaseInfo.UserProfile.UserBase.UniqId = 'another';
  assert.equal(verifyTikTokStudioOwner(payload), false);
});
test('nickname, unrelated nested handle, failure payload and unsafe numeric ID cannot prove the owner', () => {
  assert.equal(verifyTikTokStudioOwner({ statusCode: 0, handle: 'lifehack__aibal' }), false);
  assert.equal(verifyTikTokStudioOwner({ statusCode: 0, userBaseInfo: { UserProfile: { UserBase: { Id: '123', NickName: 'lifehack__aibal' } } } }), false);
  for (const patch of [{ Id: 12345678901234567 }, { Id: '' }, { UniqId: 'lifehack__ailab' }]) {
    assert.equal(verifyTikTokStudioOwner({ statusCode: 0, userBaseInfo: { UserProfile: { UserBase: { Id: '123', UniqId: 'lifehack__aibal', ...patch } } } }), false);
  }
  assert.equal(verifyTikTokStudioOwner({ statusCode: 1, userBaseInfo: { UserProfile: { UserBase: { Id: '123', UniqId: 'lifehack__aibal' } } } }), false);
});
