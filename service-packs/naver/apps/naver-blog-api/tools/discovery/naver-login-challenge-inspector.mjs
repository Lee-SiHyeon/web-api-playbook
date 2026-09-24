import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerNaverLoginChallenge } from '../../scripts/naver-login-challenge.mjs';

// Operator/agent answer adapter. Naver tokens and cookies never leave the client.
export async function inspectAndContinueChallenge(context) {
  if (!process.stdin.isTTY) throw new Error('LOGIN_CHALLENGE_TTY_REQUIRED');
  return answerNaverLoginChallenge(context, async ({ question, imageBytes, mime }) => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'naver-login-challenge-'));
    const imagePath = path.join(temporary, 'challenge.png');
    writeFileSync(imagePath, imageBytes);
    const lines = createInterface({ input: process.stdin, terminal: false });
    try {
      console.log(JSON.stringify({ challengePending: true, question, imagePath, mime,
        input: 'Supply one JSON line with operation=answer and answer, or operation=abort.' }));
      for await (const line of lines) {
        if (line.length > 1024) throw new Error('LOGIN_CHALLENGE_COMMAND_SIZE');
        const command = JSON.parse(line);
        if (command.operation === 'abort') throw new Error('LOGIN_CHALLENGE_CANCELLED');
        if (command.operation !== 'answer') throw new Error('LOGIN_CHALLENGE_COMMAND_INVALID');
        return command.answer;
      }
      throw new Error('LOGIN_CHALLENGE_INPUT_MISSING');
    } finally {
      lines.close();
      const expectedPrefix = path.resolve(os.tmpdir()) + path.sep + 'naver-login-challenge-';
      if (!path.resolve(temporary).startsWith(expectedPrefix)) throw new Error('LOGIN_CHALLENGE_CLEANUP_SCOPE');
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
