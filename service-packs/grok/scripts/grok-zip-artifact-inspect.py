#!/usr/bin/env python3
"""Read-only CRC and exact-entry verification for one task-owned ZIP artifact."""

import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import zipfile


MAX_PACKET_BYTES = 16 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024
MAX_ENTRY_BYTES = 2 * 1024 * 1024
ARTIFACT_ROOT = pathlib.Path.home() / 'artifacts' / 'grok-conversation-files-20261006'


def emit(status, **fields):
    sys.stdout.write(json.dumps({'status': status, **fields}, separators=(',', ':')) + '\n')


def main():
    raw = sys.stdin.buffer.read(MAX_PACKET_BYTES + 1)
    if len(raw) > MAX_PACKET_BYTES:
        emit('invalid_input', errorCode='ZIP_INSPECT_PACKET_TOO_LARGE')
        return 2
    try:
        packet = json.loads(raw.decode('utf-8'))
    except Exception:
        emit('invalid_input', errorCode='ZIP_INSPECT_PACKET_INVALID')
        return 2
    if not isinstance(packet, dict) or set(packet) != {'artifactPath', 'expectedEntryName'}:
        emit('invalid_input', errorCode='ZIP_INSPECT_PACKET_INVALID')
        return 2
    artifact_value = packet.get('artifactPath')
    expected_name = packet.get('expectedEntryName')
    if (not isinstance(artifact_value, str) or not os.path.isabs(artifact_value)
            or not isinstance(expected_name, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', expected_name)):
        emit('invalid_input', errorCode='ZIP_INSPECT_PACKET_INVALID')
        return 2
    root = ARTIFACT_ROOT.resolve(strict=True)
    archive = pathlib.Path(artifact_value)
    try:
        archive.resolve(strict=True).relative_to(root)
        info = os.lstat(archive)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size < 22 or info.st_size > MAX_ARCHIVE_BYTES:
            raise ValueError('invalid_archive_file')
        with archive.open('rb') as source:
            magic = source.read(4)
        if magic != b'PK\x03\x04':
            raise ValueError('archive_magic_invalid')
        with zipfile.ZipFile(archive, 'r') as zipped:
            members = zipped.infolist()
            files = [item for item in members if not item.is_dir()]
            if len(members) > 64 or len(files) != 1 or files[0].file_size > MAX_ENTRY_BYTES:
                raise ValueError('archive_entry_scope_invalid')
            total = sum(item.file_size for item in files)
            if total > MAX_UNCOMPRESSED_BYTES:
                raise ValueError('archive_uncompressed_limit')
            for item in members:
                name = item.filename
                if (name.startswith('/') or '\\' in name or any(part in ('.', '..') for part in name.split('/'))
                        or re.match(r'^[A-Za-z]:', name)):
                    raise ValueError('archive_entry_path_invalid')
                mode = (item.external_attr >> 16) & 0xffff
                if stat.S_ISLNK(mode):
                    raise ValueError('archive_symlink_rejected')
            if files[0].filename.split('/')[-1] != expected_name:
                raise ValueError('archive_expected_entry_missing')
            broken = zipped.testzip()
            if broken is not None:
                raise ValueError('archive_crc_failed')
            content = bytearray(zipped.read(files[0]))
            if len(content) != files[0].file_size or b'\0' in content:
                raise ValueError('archive_entry_content_invalid')
            try:
                text = content.decode('utf-8-sig', errors='strict')
            except UnicodeDecodeError:
                raise ValueError('archive_entry_text_invalid')
            rows = [line for line in text.replace('\r\n', '\n').split('\n') if line]
            expected = ['item,count', 'neutral,14']
            if rows != expected:
                raise ValueError('archive_csv_semantics_mismatch')
            entry_digest = hashlib.sha256(content).hexdigest()
            content[:] = b'\0' * len(content)
            emit('verified', archiveBytes=info.st_size, entryCount=len(files), entryBytes=files[0].file_size,
                 entrySha256=entry_digest, csvRows=2, csvColumns=2, crcVerified=True,
                 archiveMagicVerified=True, entryNamePersisted=False)
            return 0
    except FileNotFoundError:
        emit('invalid_input', errorCode='ZIP_INSPECT_FILE_MISSING')
        return 2
    except ValueError as exc:
        code = str(exc) if re.fullmatch(r'[a-z_]{1,64}', str(exc)) else 'ZIP_INSPECT_FAILED'
        emit('needs_review', errorCode=code)
        return 1
    except Exception:
        emit('needs_review', errorCode='ZIP_INSPECT_FAILED')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
