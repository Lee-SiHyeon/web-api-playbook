import {
  authenticateMyrealtrip,
  checkMyrealtripSession,
  myrealtripAuthStatus,
} from '../adapters/myrealtrip-auth.mjs';

const command = process.argv[2];

try {
  if (command === 'status') {
    console.log(JSON.stringify(await myrealtripAuthStatus()));
  } else if (command === 'session:health') {
    const result = await checkMyrealtripSession();
    console.log(JSON.stringify({ ok: true, provider: 'myrealtrip', ...result }));
  } else if (command === 'login:auto') {
    const result = await authenticateMyrealtrip({ allowPasswordLogin: true });
    console.log(JSON.stringify({ ok: true, provider: 'myrealtrip', ...result }));
  } else {
    throw new Error('Use status, session:health, or login:auto');
  }
} catch (error) {
  const code = /^[A-Z][A-Z_]+$/.test(error.code||error.message||'') ? (error.code||error.message) : 'MRT_AUTH_FAILED';
  console.error(JSON.stringify({ ok: false, provider: 'myrealtrip', code }));
  process.exitCode = 1;
}
