import asyncio
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
import sys

import websocket
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.grok_owned_page_guard_lifecycle import (
    GuardActivity,
    OwnedPageGuardLifecycle,
    OwnedPageGuardLifecycleError,
)


ROLE = 'codex-grok-guard-loopback-20261006'
TARGET_ID = 'A' * 32
BUSINESS_FRAME = 'synthetic-business-frame-loopback-only'


class LoopbackWebSocketServer:
    def __init__(self):
        self.messages = []
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.stop = threading.Event()
        self.port = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    async def _handler(self, connection):
        async for message in connection:
            with self.lock:
                self.messages.append(message)

    async def _serve(self):
        async with websockets.serve(self._handler, '127.0.0.1', 0) as server:
            self.port = server.sockets[0].getsockname()[1]
            self.ready.set()
            while not self.stop.is_set():
                await asyncio.sleep(0.01)

    def _run(self):
        asyncio.run(self._serve())

    def __enter__(self):
        self.thread.start()
        if not self.ready.wait(5):
            raise RuntimeError('LOOPBACK_SERVER_START_FAILED')
        return self

    def __exit__(self, *_args):
        self.stop.set()
        self.thread.join(timeout=5)

    def wait_for_messages(self, count, timeout=2):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if len(self.messages) >= count:
                    return True
            time.sleep(0.01)
        return False

    def snapshot(self):
        with self.lock:
            return list(self.messages)


class FakeSyncPage:
    def __init__(self, role):
        self.url = 'about:blank'
        self.window_name = role
        self.http_handler = None
        self.websocket_handler = None
        self.fail_goto = False
        self.closed = False

    def evaluate(self, source, value=None):
        if 'window.name = value' in source:
            self.window_name = value
            return None
        if '() => window.name' in source:
            return self.window_name
        raise AssertionError('UNEXPECTED_EVALUATION')

    def route(self, _pattern, handler):
        self.http_handler = handler

    def route_web_socket(self, _pattern, handler):
        self.websocket_handler = handler

    def goto(self, url, **_kwargs):
        if self.fail_goto:
            raise RuntimeError('SYNTHETIC_NAVIGATION_FAILURE')
        self.url = url

    def wait_for_timeout(self, milliseconds):
        time.sleep(milliseconds / 1000)

    def is_closed(self):
        return self.closed

    def close(self, run_before_unload=False):
        assert run_before_unload is False
        self.closed = True

    def unroute_all(self, *_args, **_kwargs):
        self.http_handler = None
        self.websocket_handler = None


class FakeAsyncPage:
    def __init__(self, role):
        self.url = 'about:blank'
        self.window_name = role
        self.http_handler = None
        self.websocket_handler = None
        self.fail_goto = False

    async def evaluate(self, source, value=None):
        if 'window.name = value' in source:
            self.window_name = value
            return None
        if '() => window.name' in source:
            return self.window_name
        raise AssertionError('UNEXPECTED_EVALUATION')

    async def route(self, _pattern, handler):
        self.http_handler = handler

    async def route_web_socket(self, _pattern, handler):
        self.websocket_handler = handler

    async def goto(self, url, **_kwargs):
        if self.fail_goto:
            raise RuntimeError('SYNTHETIC_NAVIGATION_FAILURE')
        self.url = url


class FakePageCDP:
    def __init__(self):
        self.target_id = TARGET_ID

    def send(self, method, _params=None):
        assert method == 'Target.getTargetInfo'
        return {'targetInfo': {'targetId': self.target_id}}


class FakeAsyncPageCDP:
    def __init__(self):
        self.target_id = TARGET_ID

    async def send(self, method, _params=None):
        assert method == 'Target.getTargetInfo'
        return {'targetInfo': {'targetId': self.target_id}}


class FakeBrowserCDP:
    def __init__(self, *, succeed=True):
        self.closed_target_ids = []
        self.succeed = succeed

    def send(self, method, params=None):
        assert method == 'Target.closeTarget'
        self.closed_target_ids.append(params['targetId'])
        return {'success': self.succeed}


class FakeAsyncBrowserCDP:
    def __init__(self):
        self.closed_target_ids = []

    async def send(self, method, params=None):
        assert method == 'Target.closeTarget'
        self.closed_target_ids.append(params['targetId'])
        return {'success': True}


class FakeSyncRawWebSocket:
    def __init__(self, socket):
        self.socket = socket
        self.callback = None

    def connect_to_server(self):
        return self

    def on_message(self, callback):
        self.callback = callback

    def send(self, message):
        self.socket.send(message)

    def close(self, code=1000, reason=''):
        self.socket.close(status=code, reason=reason)

    def deliver_page_message(self, message):
        if self.callback is not None:
            self.callback(message)


class FakeAsyncRawWebSocket:
    def __init__(self, socket):
        self.socket = socket
        self.callback = None

    async def connect_to_server(self):
        return self

    def on_message(self, callback):
        self.callback = callback

    async def send(self, message):
        await self.socket.send(message)

    async def close(self, code=1000, reason=''):
        await self.socket.close(code=code, reason=reason)

    async def deliver_page_message(self, message):
        if self.callback is not None:
            result = self.callback(message)
            if asyncio.iscoroutine(result):
                await result


def make_lifecycle(root, activity=None):
    registry = root / 'page-role-registry.json'
    registry.write_text(json.dumps({
        'schemaVersion': 1,
        'activePageRoles': {
            ROLE: {'origin': 'https://grok.com', 'selection': 'cdp_target_id', 'exactMarkerCount': 1,
                   'targetId': TARGET_ID},
            'codex-grok-unrelated-20261006': {'origin': 'https://grok.com', 'selection': 'cdp_target_id',
                                             'exactMarkerCount': 1, 'targetId': 'B' * 32},
        },
    }))
    return OwnedPageGuardLifecycle(role_registry_path=registry, role=ROLE, target_id=TARGET_ID,
                                   activity=activity), registry


def http_deny_policy(route):
    route.abort('blockedbyclient')


def websocket_drop_business_policy(route):
    server = route.connect_to_server()

    def from_page(message):
        if message != BUSINESS_FRAME:
            server.send(message)

    route.on_message(from_page)
    server.on_message(lambda _message: None)


class OwnedPageGuardLifecycleTests(unittest.TestCase):
    def test_sync_finalizer_keeps_route_guard_for_delayed_loopback_send_after_capture_timeout(self):
        with tempfile.TemporaryDirectory(dir='/home/worker/.nad-scratch/tmp') as root, LoopbackWebSocketServer() as server:
            lifecycle, _registry = make_lifecycle(Path(root))
            page = FakeSyncPage(ROLE)
            page_cdp = FakePageCDP()
            activity = lifecycle.install_sync(page=page, cdp_session=page_cdp,
                http_policy=http_deny_policy, websocket_policy=websocket_drop_business_policy)
            page.url = 'https://grok.com/c'
            connection = websocket.create_connection(f'ws://127.0.0.1:{server.port}', timeout=2)
            raw_route = FakeSyncRawWebSocket(connection)
            page.websocket_handler(raw_route)
            with self.assertRaises(OwnedPageGuardLifecycleError):
                page.unroute_all()
            capture_timed_out = True
            delayed = threading.Timer(0.15, lambda: raw_route.deliver_page_message(BUSINESS_FRAME))
            delayed.start()
            result = lifecycle.finalize_sync(page=page, cdp_session=page_cdp, browser_cdp_session=FakeBrowserCDP(),
                quiet_ms=250, max_wait_ms=2_000)
            delayed.join(timeout=2)
            self.assertTrue(capture_timed_out)
            self.assertEqual(result['status'], 'blank_quiet')
            self.assertTrue(result['quietVerified'])
            self.assertTrue(result['guardStillActive'])
            self.assertEqual(server.snapshot(), [])
            self.assertEqual(activity.snapshot()['websocketEvents'] >= 2, True)
            self.assertEqual(page.url, 'about:blank')
            self.assertEqual(page.window_name, ROLE)
            page.unroute_all()  # Route teardown is permitted only after blank+quiet verification.
            connection.close()

    def test_async_finalizer_keeps_guard_during_delayed_loopback_send(self):
        async def scenario():
            with tempfile.TemporaryDirectory(dir='/home/worker/.nad-scratch/tmp') as root, LoopbackWebSocketServer() as server:
                lifecycle, _registry = make_lifecycle(Path(root))
                page = FakeAsyncPage(ROLE)
                page_cdp = FakeAsyncPageCDP()
                async def async_policy(route):
                    upstream = await route.connect_to_server()
                    async def from_page(message):
                        if message != BUSINESS_FRAME:
                            await upstream.send(message)
                    route.on_message(from_page)
                    upstream.on_message(lambda _message: None)
                activity = await lifecycle.install_async(page=page, cdp_session=page_cdp,
                    http_policy=http_deny_policy, websocket_policy=async_policy)
                page.url = 'https://grok.com/c'
                connection = await websockets.connect(f'ws://127.0.0.1:{server.port}')
                raw_route = FakeAsyncRawWebSocket(connection)
                await page.websocket_handler(raw_route)
                delayed = asyncio.create_task(asyncio.sleep(0.15))
                async def late_send():
                    await delayed
                    await raw_route.deliver_page_message(BUSINESS_FRAME)
                late = asyncio.create_task(late_send())
                result = await lifecycle.finalize_async(page=page, cdp_session=page_cdp,
                    browser_cdp_session=FakeAsyncBrowserCDP(), quiet_ms=250, max_wait_ms=2_000)
                await late
                self.assertEqual(result['status'], 'blank_quiet')
                self.assertTrue(result['guardStillActive'])
                self.assertEqual(server.snapshot(), [])
                self.assertTrue(activity.snapshot()['websocketEvents'] >= 2)
                self.assertEqual(page.url, 'about:blank')
                self.assertEqual(page.window_name, ROLE)
                await connection.close()
        asyncio.run(scenario())

    def test_unguarded_loopback_control_delivers_delayed_send_after_reset(self):
        with LoopbackWebSocketServer() as server:
            connection = websocket.create_connection(f'ws://127.0.0.1:{server.port}', timeout=2)
            page = FakeSyncPage(ROLE)
            raw_route = FakeSyncRawWebSocket(connection)
            raw_route.on_message(lambda message: raw_route.send(message))
            page.goto('about:blank')
            delayed = threading.Timer(0.1, lambda: raw_route.deliver_page_message(BUSINESS_FRAME))
            delayed.start()
            self.assertTrue(server.wait_for_messages(1))
            delayed.join(timeout=2)
            self.assertEqual(server.snapshot(), [BUSINESS_FRAME])
            connection.close()

    def test_failed_reset_closes_only_exact_registered_target_and_marks_role_closed_atomically(self):
        with tempfile.TemporaryDirectory(dir='/home/worker/.nad-scratch/tmp') as root:
            lifecycle, registry_path = make_lifecycle(Path(root))
            page = FakeSyncPage(ROLE)
            page.fail_goto = True
            page_cdp = FakePageCDP()
            lifecycle.install_sync(page=page, cdp_session=page_cdp,
                http_policy=http_deny_policy, websocket_policy=websocket_drop_business_policy)
            page.url = 'https://grok.com/c'
            browser_cdp = FakeBrowserCDP()
            result = lifecycle.finalize_sync(page=page, cdp_session=page_cdp, browser_cdp_session=browser_cdp,
                quiet_ms=50, max_wait_ms=100)
            self.assertEqual(result['status'], 'closed_owned_target')
            self.assertEqual(browser_cdp.closed_target_ids, [TARGET_ID])
            registry = json.loads(registry_path.read_text())
            closed = registry['activePageRoles'][ROLE]
            self.assertTrue(closed['closed'])
            self.assertEqual(closed['selection'], 'owned_target_closed')
            self.assertEqual(closed['exactMarkerCount'], 0)
            self.assertEqual(registry['activePageRoles']['codex-grok-unrelated-20261006']['targetId'], 'B' * 32)
            self.assertFalse(hasattr(browser_cdp, 'close'))

    def test_failed_cdp_close_falls_back_to_only_the_exact_bound_page(self):
        with tempfile.TemporaryDirectory(dir='/home/worker/.nad-scratch/tmp') as root:
            lifecycle, registry_path = make_lifecycle(Path(root))
            page = FakeSyncPage(ROLE)
            page.fail_goto = True
            page_cdp = FakePageCDP()
            lifecycle.install_sync(page=page, cdp_session=page_cdp,
                http_policy=http_deny_policy, websocket_policy=websocket_drop_business_policy)
            page.url = 'https://grok.com/c'
            browser_cdp = FakeBrowserCDP(succeed=False)
            result = lifecycle.finalize_sync(page=page, cdp_session=page_cdp,
                browser_cdp_session=browser_cdp, quiet_ms=50, max_wait_ms=100)
            self.assertEqual(result['status'], 'closed_owned_target')
            self.assertTrue(page.closed)
            self.assertEqual(browser_cdp.closed_target_ids, [TARGET_ID])
            closed = json.loads(registry_path.read_text())['activePageRoles'][ROLE]
            self.assertTrue(closed['closed'])
            self.assertEqual(closed['selection'], 'owned_target_closed')


if __name__ == '__main__':
    unittest.main()
