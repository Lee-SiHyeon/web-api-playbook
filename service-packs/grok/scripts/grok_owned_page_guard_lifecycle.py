"""Owned-page guard installation and finalization for Grok capture runners.

This helper is for one registered page target only. It never closes a browser or
browser context, and it never removes a live HTTP/WebSocket guard. Callers keep
their source-specific allow/block policy; this module wraps it to audit activity
and owns the blank-reset, quiet check, and exact-target fail-closed path.
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import inspect
import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


ROLE_ID = re.compile(r'^codex-grok-[A-Za-z0-9-]{8,96}$')
TARGET_ID = re.compile(r'^[A-Fa-f0-9]{32}$')
LOOPBACK_WS_PATTERN = re.compile(r'^ws://127\.0\.0\.1:[1-9][0-9]{1,4}/\*\*$')
ORIGIN = 'https://grok.com'


class OwnedPageGuardLifecycleError(RuntimeError):
    """A safe, non-secret lifecycle failure code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class GuardActivity:
    """Small in-memory counter used to prove the guarded page became quiet."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sequence = 0
        self._http_events = 0
        self._websocket_events = 0
        self._last_activity = time.monotonic()
        self.http_guard_installed_before_navigation = False
        self.websocket_guard_installed_before_navigation = False
        self.routes_active = False
        self.quiet_verified = False
        self.unroute_method_protected = False

    def touch(self, kind: str) -> None:
        with self._lock:
            self._sequence += 1
            self._last_activity = time.monotonic()
            if kind.startswith('http'):
                self._http_events += 1
            elif kind.startswith('websocket'):
                self._websocket_events += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                'sequence': self._sequence,
                'httpEvents': self._http_events,
                'websocketEvents': self._websocket_events,
                'lastActivityMonotonic': self._last_activity,
            }


class _SyncWebSocketProxy:
    def __init__(self, route: Any, activity: GuardActivity):
        self._route = route
        self._activity = activity

    @property
    def url(self):
        return self._route.url

    def connect_to_server(self):
        self._activity.touch('websocket_server_connect')
        return _SyncWebSocketProxy(self._route.connect_to_server(), self._activity)

    def on_message(self, callback: Callable[[Any], Any]):
        def observed(message):
            self._activity.touch('websocket_frame')
            return callback(message)
        return self._route.on_message(observed)

    def send(self, message):
        self._activity.touch('websocket_send')
        return self._route.send(message)

    def close(self, code=1000, reason=''):
        self._activity.touch('websocket_close')
        return self._route.close(code=code, reason=reason)


class _AsyncWebSocketProxy:
    def __init__(self, route: Any, activity: GuardActivity):
        self._route = route
        self._activity = activity

    @property
    def url(self):
        return self._route.url

    def connect_to_server(self):
        self._activity.touch('websocket_server_connect')
        result = self._route.connect_to_server()
        if inspect.isawaitable(result):
            async def resolve_server():
                server = await result
                return _AsyncWebSocketProxy(server, self._activity)
            return resolve_server()
        return _AsyncWebSocketProxy(result, self._activity)

    def on_message(self, callback: Callable[[Any], Any]):
        def observed(message):
            self._activity.touch('websocket_frame')
            result = callback(message)
            if inspect.isawaitable(result):
                try:
                    asyncio.get_running_loop().create_task(result)
                except Exception:
                    close = getattr(result, 'close', None)
                    if callable(close):
                        close()
        return self._route.on_message(observed)

    def send(self, message):
        self._activity.touch('websocket_send')
        return self._route.send(message)

    async def close(self, code=1000, reason=''):
        self._activity.touch('websocket_close')
        result = self._route.close(code=code, reason=reason)
        if inspect.isawaitable(result):
            return await result
        return result


class OwnedPageGuardLifecycle:
    """Wrap existing HTTP/WSS policies and finalize exactly one owned page."""

    def __init__(self, *, role_registry_path: str | os.PathLike[str], role: str,
                 target_id: str, origin: str = ORIGIN, activity: GuardActivity | None = None):
        self.registry_path = Path(role_registry_path)
        self.role = role
        self.target_id = target_id
        self.origin = origin
        self.activity = activity or GuardActivity()
        self._installed_page = None
        self._original_unroute_methods: dict[str, Any] = {}
        self._finalized = False
        if not ROLE_ID.fullmatch(role) or not TARGET_ID.fullmatch(target_id) or origin != ORIGIN:
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_GUARD_IDENTITY_INVALID')

    def _protect_unroute(self, page) -> None:
        """Reject premature route removal while the page may still run callbacks."""
        for name in ('unroute_all', 'unroute', 'unroute_web_socket'):
            original = getattr(page, name, None)
            if not callable(original):
                continue
            self._original_unroute_methods[name] = original

            def guarded(*args, __name=name, __original=original, **kwargs):
                if self.activity.routes_active and not self.activity.quiet_verified:
                    raise OwnedPageGuardLifecycleError('OWNED_PAGE_GUARD_PREMATURE_UNROUTE')
                return __original(*args, **kwargs)

            try:
                setattr(page, name, guarded)
            except Exception:
                continue
        self.activity.unroute_method_protected = 'unroute_all' in self._original_unroute_methods

    def _verify_role_record(self) -> None:
        try:
            document = json.loads(self.registry_path.read_text(encoding='utf-8'))
            record = document.get('activePageRoles', {}).get(self.role)
        except Exception as exc:
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_ROLE_REGISTRY_INVALID') from exc
        if not isinstance(record, dict) or record.get('closed') is True or record.get('origin') != self.origin \
                or record.get('targetId') != self.target_id:
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_ROLE_BINDING_MISMATCH')

    def _install_initial_marker_sync(self, page, cdp_session) -> None:
        self._verify_role_record()
        info = cdp_session.send('Target.getTargetInfo').get('targetInfo', {})
        if info.get('targetId') != self.target_id or page.evaluate('() => window.name') != self.role \
                or page.url != 'about:blank':
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_TARGET_PRECONDITION_FAILED')

    async def _install_initial_marker_async(self, page, cdp_session) -> None:
        self._verify_role_record()
        result = cdp_session.send('Target.getTargetInfo')
        info = await result if inspect.isawaitable(result) else result
        marker_result = page.evaluate('() => window.name')
        marker = await marker_result if inspect.isawaitable(marker_result) else marker_result
        if info.get('targetInfo', {}).get('targetId') != self.target_id or marker != self.role \
                or page.url != 'about:blank':
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_TARGET_PRECONDITION_FAILED')

    @staticmethod
    def _validate_websocket_pattern(pattern: str) -> str:
        if pattern in {'wss://grok.com/**', '**/*'} \
                or (isinstance(pattern, str) and LOOPBACK_WS_PATTERN.fullmatch(pattern)):
            return pattern
        raise OwnedPageGuardLifecycleError('OWNED_PAGE_WEBSOCKET_GUARD_PATTERN_INVALID')

    def install_sync(self, *, page, cdp_session, http_policy: Callable[[Any], Any],
                     websocket_policy: Callable[[Any], Any],
                     websocket_pattern: str = 'wss://grok.com/**') -> GuardActivity:
        self._install_initial_marker_sync(page, cdp_session)
        websocket_pattern = self._validate_websocket_pattern(websocket_pattern)

        def http_guard(route):
            self.activity.touch('http_request')
            try:
                if not callable(http_policy):
                    route.abort('blockedbyclient')
                else:
                    http_policy(route)
            except Exception:
                try:
                    route.abort('blockedbyclient')
                except Exception:
                    pass

        def websocket_guard(route):
            self.activity.touch('websocket_connection')
            try:
                if not callable(websocket_policy):
                    _SyncWebSocketProxy(route, self.activity).close(code=1000, reason='guard-policy-missing')
                else:
                    websocket_policy(_SyncWebSocketProxy(route, self.activity))
            except Exception:
                try:
                    _SyncWebSocketProxy(route, self.activity).close(code=1000, reason='guard-policy-error')
                except Exception:
                    pass

        try:
            page.route('**/*', http_guard)
            self.activity.http_guard_installed_before_navigation = True
            page.route_web_socket(websocket_pattern, websocket_guard)
            self.activity.websocket_guard_installed_before_navigation = True
        except Exception as exc:
            self.activity.routes_active = False
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_GUARD_INSTALL_FAILED') from exc
        self.activity.routes_active = True
        self._installed_page = page
        self._protect_unroute(page)
        return self.activity

    async def install_async(self, *, page, cdp_session, http_policy: Callable[[Any], Any],
                            websocket_policy: Callable[[Any], Any],
                            websocket_pattern: str = 'wss://grok.com/**') -> GuardActivity:
        await self._install_initial_marker_async(page, cdp_session)
        websocket_pattern = self._validate_websocket_pattern(websocket_pattern)

        async def http_guard(route):
            self.activity.touch('http_request')
            try:
                result = http_policy(route) if callable(http_policy) else route.abort('blockedbyclient')
                if inspect.isawaitable(result):
                    await result
            except Exception:
                try:
                    result = route.abort('blockedbyclient')
                    if inspect.isawaitable(result):
                        await result
                except Exception:
                    pass

        async def websocket_guard(route):
            self.activity.touch('websocket_connection')
            proxy = _AsyncWebSocketProxy(route, self.activity)
            try:
                if callable(websocket_policy):
                    result = websocket_policy(proxy)
                    if inspect.isawaitable(result):
                        await result
                else:
                    await proxy.close(code=1000, reason='guard-policy-missing')
            except Exception:
                try:
                    await proxy.close(code=1000, reason='guard-policy-error')
                except Exception:
                    pass

        try:
            result = page.route('**/*', http_guard)
            if inspect.isawaitable(result):
                await result
            self.activity.http_guard_installed_before_navigation = True
            result = page.route_web_socket(websocket_pattern, websocket_guard)
            if inspect.isawaitable(result):
                await result
            self.activity.websocket_guard_installed_before_navigation = True
        except Exception as exc:
            self.activity.routes_active = False
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_GUARD_INSTALL_FAILED') from exc
        self.activity.routes_active = True
        self._installed_page = page
        self._protect_unroute(page)
        return self.activity

    def _role_registry_update(self, *, quiet_verified: bool, reason: str | None = None) -> None:
        lock_path = self.registry_path.with_suffix('.lock')
        self.registry_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.registry_path.is_symlink() or lock_path.is_symlink():
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_ROLE_REGISTRY_PATH_UNSAFE')
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        os.fchmod(lock_fd, 0o600)
        with os.fdopen(lock_fd, 'r+', encoding='utf-8') as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                document = json.loads(self.registry_path.read_text(encoding='utf-8'))
                record = document.get('activePageRoles', {}).get(self.role)
                if not isinstance(record, dict) or record.get('targetId') != self.target_id \
                        or record.get('origin') != self.origin:
                    raise OwnedPageGuardLifecycleError('OWNED_PAGE_ROLE_BINDING_CHANGED')
                record['lastGuardFinalizerAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                record['lastGuardFinalizerStatus'] = 'blank_quiet' if quiet_verified else 'closed_owned_target'
                record['lastGuardQuietVerified'] = quiet_verified
                record['lastGuardActivityCount'] = self.activity.snapshot()['sequence']
                if not quiet_verified:
                    record['closed'] = True
                    record['closedAt'] = record['lastGuardFinalizerAt']
                    record['closedReason'] = reason or 'OWNED_PAGE_GUARD_FINALIZATION_FAILED'
                    record['closedTargetIdSha256'] = hashlib.sha256(self.target_id.encode('ascii')).hexdigest()
                    record['exactMarkerCount'] = 0
                    record['selection'] = 'owned_target_closed'
                self._atomic_write_registry(document)
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _atomic_write_registry(self, document: dict[str, Any]) -> None:
        encoded = json.dumps(document, ensure_ascii=False, indent=2) + '\n'
        fd, temporary = tempfile.mkstemp(prefix='.page-role-registry-', suffix='.tmp', dir=self.registry_path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.registry_path)
            directory_fd = os.open(self.registry_path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _target_matches_sync(self, page, cdp_session) -> bool:
        try:
            info = cdp_session.send('Target.getTargetInfo').get('targetInfo', {})
            return info.get('targetId') == self.target_id
        except Exception:
            return False

    async def _target_matches_async(self, page, cdp_session) -> bool:
        try:
            result = cdp_session.send('Target.getTargetInfo')
            info = await result if inspect.isawaitable(result) else result
            return info.get('targetInfo', {}).get('targetId') == self.target_id
        except Exception:
            return False

    def _close_and_mark_closed_sync(self, *, page, cdp_session, browser_cdp_session, reason: str) -> tuple[bool, bool]:
        lock_path = self.registry_path.with_suffix('.lock')
        target_closed = False
        try:
            if self.registry_path.is_symlink() or lock_path.is_symlink():
                return False, False
            lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            os.fchmod(lock_fd, 0o600)
            with os.fdopen(lock_fd, 'r+', encoding='utf-8') as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    document = json.loads(self.registry_path.read_text(encoding='utf-8'))
                    record = document.get('activePageRoles', {}).get(self.role)
                    if not isinstance(record, dict) or record.get('targetId') != self.target_id \
                            or record.get('origin') != self.origin:
                        return False, False
                    if browser_cdp_session is not None:
                        try:
                            result = browser_cdp_session.send('Target.closeTarget', {'targetId': self.target_id})
                            target_closed = not (isinstance(result, dict) and result.get('success') is False)
                        except Exception:
                            target_closed = False
                    if not target_closed and self._target_matches_sync(page, cdp_session):
                        try:
                            page.close(run_before_unload=False)
                            target_closed = bool(page.is_closed())
                        except Exception:
                            target_closed = False
                    if not target_closed:
                        return False, False
                    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                    record['lastGuardFinalizerAt'] = now
                    record['lastGuardFinalizerStatus'] = 'closed_owned_target'
                    record['lastGuardQuietVerified'] = False
                    record['lastGuardActivityCount'] = self.activity.snapshot()['sequence']
                    record['closed'] = True
                    record['closedAt'] = now
                    record['closedReason'] = reason
                    record['closedTargetIdSha256'] = hashlib.sha256(self.target_id.encode('ascii')).hexdigest()
                    record['exactMarkerCount'] = 0
                    record['selection'] = 'owned_target_closed'
                    self._atomic_write_registry(document)
                    self.activity.routes_active = False
                    return True, True
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        except Exception:
            return target_closed, False

    async def _close_and_mark_closed_async(self, *, page, cdp_session, browser_cdp_session,
                                          reason: str) -> tuple[bool, bool]:
        lock_path = self.registry_path.with_suffix('.lock')
        target_closed = False
        try:
            if self.registry_path.is_symlink() or lock_path.is_symlink():
                return False, False
            lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            os.fchmod(lock_fd, 0o600)
            with os.fdopen(lock_fd, 'r+', encoding='utf-8') as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    document = json.loads(self.registry_path.read_text(encoding='utf-8'))
                    record = document.get('activePageRoles', {}).get(self.role)
                    if not isinstance(record, dict) or record.get('targetId') != self.target_id \
                            or record.get('origin') != self.origin:
                        return False, False
                    if browser_cdp_session is not None:
                        try:
                            result = browser_cdp_session.send('Target.closeTarget', {'targetId': self.target_id})
                            if inspect.isawaitable(result):
                                result = await result
                            target_closed = not (isinstance(result, dict) and result.get('success') is False)
                        except Exception:
                            target_closed = False
                    if not target_closed and await self._target_matches_async(page, cdp_session):
                        try:
                            result = page.close(run_before_unload=False)
                            if inspect.isawaitable(result):
                                await result
                            closed = page.is_closed()
                            target_closed = await closed if inspect.isawaitable(closed) else bool(closed)
                        except Exception:
                            target_closed = False
                    if not target_closed:
                        return False, False
                    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                    record['lastGuardFinalizerAt'] = now
                    record['lastGuardFinalizerStatus'] = 'closed_owned_target'
                    record['lastGuardQuietVerified'] = False
                    record['lastGuardActivityCount'] = self.activity.snapshot()['sequence']
                    record['closed'] = True
                    record['closedAt'] = now
                    record['closedReason'] = reason
                    record['closedTargetIdSha256'] = hashlib.sha256(self.target_id.encode('ascii')).hexdigest()
                    record['exactMarkerCount'] = 0
                    record['selection'] = 'owned_target_closed'
                    self._atomic_write_registry(document)
                    self.activity.routes_active = False
                    return True, True
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        except Exception:
            return target_closed, False

    def _close_fallback_sync(self, *, page, cdp_session, browser_cdp_session, reason: str) -> dict[str, Any]:
        if not self._target_matches_sync(page, cdp_session):
            return {'status': 'ownership_lost', 'targetClosed': False, 'roleClosedAtomic': False,
                    'quietVerified': False, 'reasonCode': 'OWNED_PAGE_TARGET_BINDING_LOST'}
        closed, role_marked = self._close_and_mark_closed_sync(page=page, cdp_session=cdp_session,
            browser_cdp_session=browser_cdp_session, reason=reason)
        if not closed:
            return {'status': 'close_failed', 'targetClosed': False, 'roleClosedAtomic': False,
                    'quietVerified': False, 'reasonCode': 'OWNED_PAGE_TARGET_CLOSE_FAILED'}
        if not role_marked:
            return {'status': 'closed_role_record_failed', 'targetClosed': True, 'roleClosedAtomic': False,
                    'quietVerified': False, 'reasonCode': 'OWNED_PAGE_ROLE_CLOSE_RECORD_FAILED'}
        return {'status': 'closed_owned_target', 'targetClosed': True, 'roleClosedAtomic': True,
                'quietVerified': False, 'reasonCode': reason,
                'closedTargetIdSha256': hashlib.sha256(self.target_id.encode('ascii')).hexdigest()}

    async def _close_fallback_async(self, *, page, cdp_session, browser_cdp_session, reason: str) -> dict[str, Any]:
        if not await self._target_matches_async(page, cdp_session):
            return {'status': 'ownership_lost', 'targetClosed': False, 'roleClosedAtomic': False,
                    'quietVerified': False, 'reasonCode': 'OWNED_PAGE_TARGET_BINDING_LOST'}
        closed, role_marked = await self._close_and_mark_closed_async(page=page, cdp_session=cdp_session,
            browser_cdp_session=browser_cdp_session, reason=reason)
        if not closed:
            return {'status': 'close_failed', 'targetClosed': False, 'roleClosedAtomic': False,
                    'quietVerified': False, 'reasonCode': 'OWNED_PAGE_TARGET_CLOSE_FAILED'}
        if not role_marked:
            return {'status': 'closed_role_record_failed', 'targetClosed': True, 'roleClosedAtomic': False,
                    'quietVerified': False, 'reasonCode': 'OWNED_PAGE_ROLE_CLOSE_RECORD_FAILED'}
        return {'status': 'closed_owned_target', 'targetClosed': True, 'roleClosedAtomic': True,
                'quietVerified': False, 'reasonCode': reason,
                'closedTargetIdSha256': hashlib.sha256(self.target_id.encode('ascii')).hexdigest()}

    def finalize_sync(self, *, page, cdp_session, browser_cdp_session,
                      quiet_ms: int = 1500, max_wait_ms: int = 8000,
                      navigation_timeout_ms: int = 15000) -> dict[str, Any]:
        if self._finalized:
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_FINALIZER_ALREADY_USED')
        self._finalized = True
        guards_ready = self.activity.http_guard_installed_before_navigation \
            and self.activity.websocket_guard_installed_before_navigation and self.activity.routes_active
        if not guards_ready:
            return self._close_fallback_sync(page=page, cdp_session=cdp_session,
                browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_GUARDS_NOT_ACTIVE')
        if not self._target_matches_sync(page, cdp_session):
            return {'status': 'ownership_lost', 'targetClosed': False, 'roleClosedAtomic': False,
                    'quietVerified': False, 'reasonCode': 'OWNED_PAGE_TARGET_BINDING_LOST'}
        try:
            if page.url != 'about:blank':
                page.goto('about:blank', wait_until='domcontentloaded', timeout=navigation_timeout_ms)
            page.evaluate('(value) => { window.name = value; }', self.role)
            if page.url != 'about:blank' or page.evaluate('() => window.name') != self.role:
                raise OwnedPageGuardLifecycleError('OWNED_PAGE_RESET_MARKER_FAILED')
        except Exception:
            return self._close_fallback_sync(page=page, cdp_session=cdp_session,
                browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_RESET_FAILED')

        start = time.monotonic()
        stable_since = start
        last_sequence = self.activity.snapshot()['sequence']
        while (time.monotonic() - start) * 1000 < max_wait_ms:
            if not self._target_matches_sync(page, cdp_session):
                return {'status': 'ownership_lost', 'targetClosed': False, 'roleClosedAtomic': False,
                        'quietVerified': False, 'reasonCode': 'OWNED_PAGE_TARGET_BINDING_LOST'}
            if page.url != 'about:blank' or page.evaluate('() => window.name') != self.role:
                return self._close_fallback_sync(page=page, cdp_session=cdp_session,
                    browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_RESET_MARKER_CHANGED')
            sequence = self.activity.snapshot()['sequence']
            if sequence != last_sequence:
                last_sequence = sequence
                stable_since = time.monotonic()
            elif (time.monotonic() - stable_since) * 1000 >= quiet_ms:
                try:
                    self._role_registry_update(quiet_verified=True)
                except Exception:
                    return self._close_fallback_sync(page=page, cdp_session=cdp_session,
                        browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_ROLE_RESET_RECORD_FAILED')
                self.activity.quiet_verified = True
                snapshot = self.activity.snapshot()
                return {'status': 'blank_quiet', 'targetClosed': False, 'roleClosedAtomic': False,
                        'quietVerified': True, 'guardStillActive': self.activity.routes_active,
                        'quietMilliseconds': int((time.monotonic() - stable_since) * 1000),
                        'guardActivityCount': snapshot['sequence'], 'httpGuardEventCount': snapshot['httpEvents'],
                        'websocketGuardEventCount': snapshot['websocketEvents']}
            page.wait_for_timeout(50)
        return self._close_fallback_sync(page=page, cdp_session=cdp_session,
            browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_QUIET_WINDOW_TIMEOUT')

    async def finalize_async(self, *, page, cdp_session, browser_cdp_session,
                             quiet_ms: int = 1500, max_wait_ms: int = 8000,
                             navigation_timeout_ms: int = 15000) -> dict[str, Any]:
        if self._finalized:
            raise OwnedPageGuardLifecycleError('OWNED_PAGE_FINALIZER_ALREADY_USED')
        self._finalized = True
        guards_ready = self.activity.http_guard_installed_before_navigation \
            and self.activity.websocket_guard_installed_before_navigation and self.activity.routes_active
        if not guards_ready:
            return await self._close_fallback_async(page=page, cdp_session=cdp_session,
                browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_GUARDS_NOT_ACTIVE')
        if not await self._target_matches_async(page, cdp_session):
            return {'status': 'ownership_lost', 'targetClosed': False, 'roleClosedAtomic': False,
                    'quietVerified': False, 'reasonCode': 'OWNED_PAGE_TARGET_BINDING_LOST'}
        try:
            if page.url != 'about:blank':
                result = page.goto('about:blank', wait_until='domcontentloaded', timeout=navigation_timeout_ms)
                if inspect.isawaitable(result):
                    await result
            result = page.evaluate('(value) => { window.name = value; }', self.role)
            if inspect.isawaitable(result):
                await result
            result = page.evaluate('() => window.name')
            marker = await result if inspect.isawaitable(result) else result
            if page.url != 'about:blank' or marker != self.role:
                raise OwnedPageGuardLifecycleError('OWNED_PAGE_RESET_MARKER_FAILED')
        except Exception:
            return await self._close_fallback_async(page=page, cdp_session=cdp_session,
                browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_RESET_FAILED')

        start = time.monotonic()
        stable_since = start
        last_sequence = self.activity.snapshot()['sequence']
        while (time.monotonic() - start) * 1000 < max_wait_ms:
            if not await self._target_matches_async(page, cdp_session):
                return {'status': 'ownership_lost', 'targetClosed': False, 'roleClosedAtomic': False,
                        'quietVerified': False, 'reasonCode': 'OWNED_PAGE_TARGET_BINDING_LOST'}
            result = page.evaluate('() => window.name')
            marker = await result if inspect.isawaitable(result) else result
            if page.url != 'about:blank' or marker != self.role:
                return await self._close_fallback_async(page=page, cdp_session=cdp_session,
                    browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_RESET_MARKER_CHANGED')
            sequence = self.activity.snapshot()['sequence']
            if sequence != last_sequence:
                last_sequence = sequence
                stable_since = time.monotonic()
            elif (time.monotonic() - stable_since) * 1000 >= quiet_ms:
                try:
                    self._role_registry_update(quiet_verified=True)
                except Exception:
                    return await self._close_fallback_async(page=page, cdp_session=cdp_session,
                        browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_ROLE_RESET_RECORD_FAILED')
                self.activity.quiet_verified = True
                snapshot = self.activity.snapshot()
                return {'status': 'blank_quiet', 'targetClosed': False, 'roleClosedAtomic': False,
                        'quietVerified': True, 'guardStillActive': self.activity.routes_active,
                        'quietMilliseconds': int((time.monotonic() - stable_since) * 1000),
                        'guardActivityCount': snapshot['sequence'], 'httpGuardEventCount': snapshot['httpEvents'],
                        'websocketGuardEventCount': snapshot['websocketEvents']}
            await asyncio.sleep(0.05)
        return await self._close_fallback_async(page=page, cdp_session=cdp_session,
            browser_cdp_session=browser_cdp_session, reason='OWNED_PAGE_QUIET_WINDOW_TIMEOUT')
