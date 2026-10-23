export function replyTextMatches(item, post, replyToId) {
  if (item?.text === post) return !replyToId || item.parentId === String(replyToId);
  if (!replyToId || item?.parentId !== String(replyToId) || typeof item.text !== 'string' || !item.text.endsWith(post)) return false;
  // X automatically prepends reply participants. Accept only a pure mention prefix, never arbitrary extra prose.
  const prefix = item.text.slice(0, -post.length);
  return /^(?:@[A-Za-z0-9_]{1,15}\s+)+$/.test(prefix);
}
