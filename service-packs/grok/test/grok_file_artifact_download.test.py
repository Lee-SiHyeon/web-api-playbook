import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts' / 'grok-file-artifact-download.py'


class FileArtifactDownloadTests(unittest.TestCase):
    def run_helper(self, packet):
        return subprocess.run([sys.executable, str(HELPER)], input=json.dumps(packet), text=True,
                              capture_output=True, check=False, env={})

    def test_packet_error_is_safe_and_contains_no_url(self):
        secret_url = 'https://files.example.invalid/object?signature=opaque-value'
        result = self.run_helper({'url': secret_url})
        self.assertEqual(result.returncode, 2)
        self.assertIn('FILE_ARTIFACT_PACKET_INVALID', result.stdout)
        self.assertNotIn(secret_url, result.stdout)
        self.assertEqual(result.stderr, '')

    def test_origin_scope_error_does_not_echo_signed_url(self):
        secret_url = 'https://files.example.invalid/object?signature=opaque-value'
        result = self.run_helper({
            'url': secret_url,
            'allowedOrigins': ['https://grok.com'],
            'timeoutMs': 1000,
            'maxBytes': 1024,
        })
        self.assertEqual(result.returncode, 2)
        self.assertIn('FILE_ARTIFACT_URL_SCOPE', result.stdout)
        self.assertNotIn(secret_url, result.stdout)
        self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
