import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localPython = process.platform === 'win32'
  ? path.join(root, '.venv-oliveyoung', 'Scripts', 'python.exe')
  : path.join(root, '.venv-oliveyoung', 'bin', 'python');

// Match the maintained transport's interpreter selection for its Python tests.
export const oliveyoungTestPython = process.env.WEB_API_OLIVEYOUNG_PYTHON
  ?? (existsSync(localPython) ? localPython : 'python3');
