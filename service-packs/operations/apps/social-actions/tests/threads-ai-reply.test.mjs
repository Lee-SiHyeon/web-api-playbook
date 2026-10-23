import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateThreadsContextComments,
  threadsAiReplySettings,
  threadsBatchCommentPrompt,
  validateThreadsBatchComments,
  validateThreadsContextComment,
} from '../threads-ai-reply.mjs';

const inputs = [
  { accountId: '17890000001', post: { id: '3996994421430736441', author: 'alice_writer',
    text: 'A useful domain should be short enough to remember and share.', format: { lang: 'en' } } },
  { accountId: '17890000002', post: { id: '3996994421430736442', author: 'bob_writer',
    text: '매주 지출을 돌아보면 다음 달 계획을 세우기 쉬워요.', formatlang: 'ko' } },
];

test('Threads batch prompt is explicitly contextual, Korean/English, and excludes benefit notices and action claims', () => {
  const prompt = threadsBatchCommentPrompt(inputs);
  assert.match(prompt, /Threads post/);
  assert.match(prompt, /accountId/);
  assert.match(prompt, /Korean/);
  assert.match(prompt, /English/);
  assert.match(prompt, /specific idea/);
  assert.match(prompt, /Do not write a benefit notice, condition/);
  assert.match(prompt, /claim any follow, like, repost, reply, or other action has been completed/);
  assert.match(prompt, /untrusted quoted content/);
  assert.match(prompt, /"maxCharacters":70/);
  assert.match(prompt, /"maxCharacters":50/);
  assert.equal(threadsAiReplySettings.model, 'gpt-6-luna');
  assert.equal(threadsAiReplySettings.effort, 'low');
  assert.equal(threadsAiReplySettings.outputTokenBudget, 4096);
});

test('Threads outputs route by exact stable account ID and bind the matching post identity', () => {
  const comments = validateThreadsBatchComments({ comments: [
    { accountId: '17890000002', comment: '매주 확인하면 소비 흐름이 더 잘 보이겠어요.' },
    { accountId: '17890000001', comment: 'Short names make an idea easier to remember.' },
  ] }, inputs);
  assert.deepEqual(comments, [
    { accountId: '17890000001', postId: '3996994421430736441', postAuthor: 'alice_writer',
      comment: 'Short names make an idea easier to remember.' },
    { accountId: '17890000002', postId: '3996994421430736442', postAuthor: 'bob_writer',
      comment: '매주 확인하면 소비 흐름이 더 잘 보이겠어요.' },
  ]);
});

test('Threads batch refuses missing, duplicate, and unknown account IDs', () => {
  const bad = [
    [{ accountId: '17890000001', comment: 'A specific idea can be memorable.' }],
    [{ accountId: '17890000001', comment: 'A specific idea can be memorable.' },
      { accountId: '17890000001', comment: 'Another specific idea can be useful.' }],
    [{ accountId: '17890000001', comment: 'A specific idea can be memorable.' },
      { accountId: '17890000003', comment: 'Another specific idea can be useful.' }],
  ];
  for (const comments of bad) {
    assert.throws(() => validateThreadsBatchComments({ comments }, inputs), { code: 'THREADS_AI_BATCH_OUTPUT' });
  }
  assert.throws(() => threadsBatchCommentPrompt([inputs[0], inputs[0]]), { code: 'THREADS_AI_BATCH_INPUT' });
  const oversized = Array.from({ length: 40 }, (_, i) => ({ ...inputs[0], accountId: String(17890000100 + i) }));
  assert.throws(() => threadsBatchCommentPrompt(oversized), { code: 'THREADS_AI_OUTPUT_BUDGET' });
});

test('generation dynamically chunks by the estimated output-token budget without a fixed account cap', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ accountId: String(17890001000 + i),
    post: { id: `399699442143073${String(i).padStart(4, '0')}`, author: `author_${i}`,
      text: `A distinct useful idea number ${i} makes the example clear.`, format: { lang: 'en' } } }));
  const prompts = [];
  const result = await generateThreadsContextComments(many, { run: async prompt => {
    prompts.push(prompt);
    const rows = JSON.parse(prompt.slice(prompt.indexOf('Posts: ') + 7));
    return { comments: rows.map(row => ({ accountId: row.accountId, comment: 'A clear example makes this idea easier to use.' })) };
  } });
  assert.equal(result.comments.length, 40);
  assert.equal(result.transportChunks, 2);
  assert.equal(result.generationAttempts, 2);
  assert.equal(prompts.length, 2);
});

test('Threads text validator blocks completed-action claims, tags, links, and long drafts', () => {
  for (const text of ['I liked your post.', '이미 리포스트했어요.', '@alice_writer 좋은 관점이에요.',
    'More at https://example.com', '가'.repeat(81)]) {
    assert.throws(() => validateThreadsContextComment(text), { code: 'THREADS_AI_COMMENT_INVALID' });
  }
  assert.equal(validateThreadsContextComment('That example makes the idea much clearer.'),
    'That example makes the idea much clearer.');
});

test('invalid comment text gets one text-only retry with a 40-character cap', async () => {
  let calls = 0;
  const prompts = [];
  const result = await generateThreadsContextComments([inputs[1]], { run: async prompt => {
    prompts.push(prompt);
    calls += 1;
    return { comments: [{ accountId: '17890000002', comment: calls === 1
      ? '좋아요와 리포스트 완료했어요.'
      : '매주 돌아보면 소비 흐름을 더 잘 알 수 있겠어요.' }] };
  } });
  assert.equal(calls, 2);
  assert.equal(result.generationAttempts, 2);
  assert.match(prompts[1], /"maxCharacters":40/);
  assert.equal(result.comments[0].postId, inputs[1].post.id);
  assert.equal(result.comments[0].postAuthor, inputs[1].post.author);
  assert.equal(result.externalThreadsWrites, 0);
});

test('identity errors get one bounded shape retry before failing closed', async () => {
  let calls = 0;
  await assert.rejects(generateThreadsContextComments([inputs[0]], { run: async () => {
    calls += 1;
    return { comments: [{ accountId: '99999999999', comment: 'A useful idea to consider.' }] };
  } }), { code: 'THREADS_AI_BATCH_OUTPUT' });
  assert.equal(calls, 2);
});

test('unsupported explicit or source-script locales fail closed', () => {
  assert.doesNotThrow(() => threadsBatchCommentPrompt([{ ...inputs[0], post: {
    ...inputs[0].post, format: { lang: 'en-US' },
  } }]));
  assert.throws(() => threadsBatchCommentPrompt([{ ...inputs[0], post: {
    ...inputs[0].post, format: { lang: 'ja' },
  } }]), { code: 'THREADS_AI_LANGUAGE_UNSUPPORTED' });
  assert.throws(() => threadsBatchCommentPrompt([{ ...inputs[0], post: {
    ...inputs[0].post, text: '日本語だけの投稿です。', format: { lang: 'en' },
  } }]), { code: 'THREADS_AI_LANGUAGE_UNSUPPORTED' });
});

test('language detection ignores URLs, honors reader language metadata, and handles Korean with English names', () => {
  assert.equal(threadsBatchCommentPrompt([{ ...inputs[0], post: {
    ...inputs[0].post,
    text: '오늘 점심이 정말 맛있었어요. https://example.com/this-is-a-long-english-url-with-business-names',
    format: {},
  } }]).includes('language":"Korean"'), true);
  assert.equal(threadsBatchCommentPrompt([{ ...inputs[0], post: {
    ...inputs[0].post, text: '카카오, 네이버, Toss, Google Ads, Customer Data Platform을 비교해요.', format: {},
  } }]).includes('language":"Korean"'), true);
  assert.equal(threadsBatchCommentPrompt([{ ...inputs[0], post: {
    ...inputs[0].post, text: 'A mostly English sentence.', language: 'ko',
  } }]).includes('language":"Korean"'), true);
});

test('output locale must match the requested language while supported bilingual text remains valid', () => {
  for (const comment of [
    'Thinking about weekly spending can help with planning.',
    '每周回顾支出会更容易做计划。',
  ]) assert.throws(() => validateThreadsBatchComments({ comments: [
    { accountId: inputs[1].accountId, comment },
  ] }, [inputs[1]]), { code: 'THREADS_AI_COMMENT_INVALID' });
  assert.deepEqual(validateThreadsBatchComments({ comments: [
    { accountId: inputs[1].accountId, comment: '이 정리는 helpful해 보여요.' },
  ] }, [{ ...inputs[1], maxCharacters: 80 }])[0].comment, '이 정리는 helpful해 보여요.');
  assert.deepEqual(validateThreadsBatchComments({ comments: [
    { accountId: inputs[1].accountId, comment: '카카오, 네이버, Toss, Google Ads, Customer Data Platform을 비교해요.' },
  ] }, [{ ...inputs[1], maxCharacters: 80 }])[0].comment, '카카오, 네이버, Toss, Google Ads, Customer Data Platform을 비교해요.');
});

test('wrong, missing, and duplicate account IDs get one shape-only retry', async () => {
  const malformed = [
    [
      { accountId: '17890000003', comment: 'A clear example makes this easier to use.' },
      { accountId: inputs[1].accountId, comment: '매주 돌아보면 계획을 세우기 쉬워요.' },
    ],
    [{ accountId: inputs[0].accountId, comment: 'A clear example makes this easier to use.' }],
    [
      { accountId: inputs[0].accountId, comment: 'A clear example makes this easier to use.' },
      { accountId: inputs[0].accountId, comment: '매주 돌아보면 계획을 세우기 쉬워요.' },
    ],
  ];
  for (const badComments of malformed) {
    let calls = 0;
    const prompts = [];
    const result = await generateThreadsContextComments(inputs, { run: async prompt => {
      calls += 1;
      prompts.push(prompt);
      return { comments: calls === 1 ? badComments : [
        { accountId: inputs[0].accountId, comment: 'Short names make an idea easier to remember.' },
        { accountId: inputs[1].accountId, comment: '매주 돌아보면 계획을 세우기 쉬워요.' },
      ] };
    } });
    assert.equal(calls, 2);
    assert.equal(result.generationAttempts, 2);
    assert.equal(result.externalThreadsWrites, 0);
    assert.match(prompts[1], /exactly one row for each provided accountId/);
    assert.doesNotMatch(prompts[1], /"maxCharacters":40/);
  }
});

test('credential solicitation is rejected, advice against sharing credentials is allowed, and text retries once', async () => {
  for (const text of [
    'Send me your login credentials so I can help.',
    '비밀번호를 알려 주세요.',
    'Please share your API key with me.',
    'Never share passwords. Send me your API key.',
    'Never share passwords, send me your API key.',
    'Never share your password with anyone, but send me your API key.',
    '비밀번호는 공유하지 마세요. API 키를 알려 주세요.',
    '비밀번호를 알려주지 말고 API 키를 보내 주세요.',
  ]) {
    assert.throws(() => validateThreadsContextComment(text), { code: 'THREADS_AI_COMMENT_INVALID' });
  }
  assert.equal(validateThreadsContextComment('Never share your password with anyone.'),
    'Never share your password with anyone.');
  assert.equal(validateThreadsContextComment('비밀번호를 다른 사람과 공유하지 마세요.'),
    '비밀번호를 다른 사람과 공유하지 마세요.');
  assert.equal(validateThreadsContextComment('비밀번호를 알려주지 말고 안전하게 보관하세요.'),
    '비밀번호를 알려주지 말고 안전하게 보관하세요.');

  let calls = 0;
  const result = await generateThreadsContextComments([inputs[0]], { run: async () => {
    calls += 1;
    return { comments: [{ accountId: inputs[0].accountId, comment: calls === 1
      ? 'Send me your password so I can check.'
      : 'Short names make ideas easy to share.' }] };
  } });
  assert.equal(calls, 2);
  assert.equal(result.generationAttempts, 2);
  assert.equal(result.comments[0].comment, 'Short names make ideas easy to share.');
  assert.equal(result.externalThreadsWrites, 0);
});
