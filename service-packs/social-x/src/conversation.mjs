// TweetDetail is a ranked, partial conversation, never a representative poll.
export function decodeConversation(instructions, focalId) {
  if (!Array.isArray(instructions) || !/^\d{1,25}$/.test(focalId)) throw Error('CONVERSATION_SCHEMA');
  const tweets = new Map(), cursors = [];
  const metric = v => v != null && /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
  function visit(content) {
    const c = content?.itemContent ?? content;
    if (!c || content?.promotedMetadata || c.promotedMetadata) return;
    if (c.cursorType && typeof c.value === 'string') cursors.push({type:c.cursorType,value:c.value});
    const outer = c.tweet_results?.result, t = outer?.__typename === 'TweetWithVisibilityResults' ? outer.tweet : outer;
    const u = t?.core?.user_results?.result, author = u?.core?.screen_name ?? u?.legacy?.screen_name;
    if (t?.__typename !== 'Tweet' || !/^[A-Za-z0-9_]{1,15}$/.test(author ?? '') || !/^\d{1,25}$/.test(t.rest_id ?? '') || t.legacy?.retweeted_status_result) return;
    const l = t.legacy ?? {}; let text = t.note_tweet?.note_tweet_results?.result?.text ?? l.full_text;
    if (typeof text !== 'string') return;
    text = text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    for (const link of l.entities?.urls ?? []) if (typeof link.url === 'string' && typeof link.expanded_url === 'string') text = text.split(link.url).join(link.expanded_url);
    tweets.set(t.rest_id,{id:t.rest_id,author,text,url:`https://x.com/${author}/status/${t.rest_id}`,createdAt:l.created_at ?? null,parentId:l.in_reply_to_status_id_str ?? null,conversationId:l.conversation_id_str ?? null,metrics:{likes:metric(l.favorite_count),replies:metric(l.reply_count),reposts:metric(l.retweet_count),views:metric(t.views?.count)}});
  }
  for (const instruction of instructions) {
    for (const e of instruction.entries ?? (instruction.entry ? [instruction.entry] : [])) {
      if (e.content?.promotedMetadata) continue;
      visit(e.content); for (const child of e.content?.items ?? []) visit(child.item);
    }
    for (const child of instruction.moduleItems ?? []) visit(child.item);
  }
  const focal = tweets.get(focalId); if (!focal) throw Error('FOCAL_MISSING');
  const connected = new Set([focalId]);
  for (let changed = true; changed;) { changed=false; for (const t of tweets.values()) if (!connected.has(t.id) && connected.has(t.parentId)) {connected.add(t.id);changed=true;} }
  return {focal,replies:[...tweets.values()].filter(t=>t.id!==focalId&&connected.has(t.id)),excludedUnconnected:[...tweets.keys()].filter(id=>!connected.has(id)).length,cursors,ranking:'Relevance',complete:false,representative:false};
}
