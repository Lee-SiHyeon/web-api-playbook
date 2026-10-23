"""Real isolated Chromium loopback regression for the owned-page finalizer."""

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets
from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.grok_owned_page_guard_lifecycle import GuardActivity, OwnedPageGuardLifecycle


HOME_SCRATCH = Path('/home/worker/.nad-scratch/tmp')
RUNTIME_OWNER = Path('/home/worker/.nad-scratch/provider-runtime-20261005/runtime-owner.json')
ROLE_ORIGIN = 'https://grok.com'
CONTROL_FRAME = 'LOOPBACK_PREEXISTING_SOCKET_CONTROL'
GUARDED_FRAME = 'LOOPBACK_GUARDED_DELAYED_BUSINESS'
NATIVE_CONTROL_FRAME = 'LOOPBACK_NATIVE_SESSION_CONTROL'
CONTROL_ACK_FRAME = 'LOOPBACK_NATIVE_SESSION_ACK'
NATIVE_BUSINESS_FRAME = 'LOOPBACK_NATIVE_RESPONSE_CREATE'


class LocalPageServer:
    def __init__(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'<!doctype html><html><body>loopback guard test</body></html>'
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


class RealChromeGuardLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        HOME_SCRATCH.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            owner = json.loads(RUNTIME_OWNER.read_text(encoding='utf-8'))
            chrome_pid = int(owner['chromePid'])
            self.executable = os.readlink(f'/proc/{chrome_pid}/exe')
        except Exception:
            self.skipTest('TASK_CHROME_EXECUTABLE_UNAVAILABLE')
        if not os.path.isfile(self.executable) or not os.access(self.executable, os.X_OK):
            self.skipTest('TASK_CHROME_EXECUTABLE_UNAVAILABLE')
        self.temp = tempfile.TemporaryDirectory(dir=HOME_SCRATCH)
        self.profile = Path(self.temp.name) / 'isolated-chrome-profile'
        self.http = LocalPageServer()
        self.http.start()
        self.messages = []
        self.ws_server = await websockets.serve(self._websocket_handler, '127.0.0.1', 0)
        self.ws_port = self.ws_server.sockets[0].getsockname()[1]
        self.playwright = await async_playwright().start()
        self.context = await self.playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.profile), executable_path=self.executable, headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
                  '--disable-component-update', '--disable-default-apps', '--no-first-run'],
        )

    async def _websocket_handler(self, connection):
        async for message in connection:
            self.messages.append(message)
            if message == NATIVE_CONTROL_FRAME:
                await connection.send(CONTROL_ACK_FRAME)

    async def asyncTearDown(self):
        if getattr(self, 'context', None) is not None:
            await self.context.close()  # Only this test-owned browser/profile is closed.
        if getattr(self, 'playwright', None) is not None:
            await self.playwright.stop()
        if getattr(self, 'ws_server', None) is not None:
            self.ws_server.close()
            await self.ws_server.wait_closed()
        if getattr(self, 'http', None) is not None:
            self.http.stop()
        if getattr(self, 'temp', None) is not None:
            self.temp.cleanup()

    async def _open_websocket(self, page, path):
        url = f'ws://127.0.0.1:{self.ws_port}/{path}'
        opened = await page.evaluate("""url => new Promise(resolve => {
          const socket = new WebSocket(url);
          window.__guardLifecycleSocket = socket;
          socket.addEventListener('open', () => resolve(true), {once:true});
          socket.addEventListener('error', () => resolve(false), {once:true});
        })""", url)
        self.assertTrue(opened)

    async def test_existing_socket_teardown_control_and_guarded_finalizer(self):
        local_page_url = f'http://127.0.0.1:{self.http.port}/'
        route_pattern = f'ws://127.0.0.1:{self.ws_port}/**'

        # Old teardown control: routeWebSocket is attached after the socket exists,
        # then removed before a queued send. The real browser sends it to loopback.
        old_page = await self.context.new_page()
        await old_page.goto(local_page_url, wait_until='load')
        await self._open_websocket(old_page, 'preexisting')
        late_route_calls = []
        async def late_socket_guard(route):
            late_route_calls.append(True)
            await route.close(code=1000, reason='late-route-control')
        await old_page.route_web_socket(route_pattern, late_socket_guard)
        await old_page.unroute_all()
        await old_page.evaluate("""() => {
          window.__captureTimedOut = true;
          setTimeout(() => { window.__guardLifecycleSocket.send('LOOPBACK_PREEXISTING_SOCKET_CONTROL'); window.__lateSent = true; }, 100);
        }""")
        await old_page.wait_for_function('() => window.__lateSent === true', timeout=3000)
        deadline = asyncio.get_running_loop().time() + 2
        while CONTROL_FRAME not in self.messages and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        self.assertIn(CONTROL_FRAME, self.messages)
        self.assertEqual(late_route_calls, [])
        await old_page.close()

        # Fixed path: helper guards are installed before navigation and before the
        # new loopback socket. A delayed page action after capture timeout is observed
        # by the route guard and dropped before the page is reset to blank.
        self.messages.clear()
        page = await self.context.new_page()
        role = 'codex-grok-guard-browser-fixed-20261006'
        await page.evaluate('(value) => { window.name = value; }', role)
        cdp = await self.context.new_cdp_session(page)
        target_info = await cdp.send('Target.getTargetInfo')
        target_id = target_info.get('targetInfo', {}).get('targetId')
        self.assertTrue(isinstance(target_id, str) and re.fullmatch(r'[A-Fa-f0-9]{32}', target_id))

        role_registry_path = Path(self.temp.name) / 'page-role-registry.json'
        role_registry_path.write_text(json.dumps({'schemaVersion': 1, 'activePageRoles': {
            role: {'origin': ROLE_ORIGIN, 'selection': 'cdp_target_id', 'exactMarkerCount': 1,
                   'targetId': target_id},
        }}))
        os.chmod(role_registry_path, 0o600)
        activity = GuardActivity()
        lifecycle = OwnedPageGuardLifecycle(role_registry_path=role_registry_path, role=role,
            target_id=target_id, activity=activity)
        dropped_frames = []

        async def http_policy(route):
            request = route.request
            if request.method == 'GET' and request.url == local_page_url:
                await route.continue_()
            else:
                await route.abort('blockedbyclient')

        async def websocket_policy(route):
            upstream = route.connect_to_server()
            if asyncio.iscoroutine(upstream):
                upstream = await upstream
            async def from_page(message):
                if message == GUARDED_FRAME:
                    dropped_frames.append(True)
                else:
                    result = upstream.send(message)
                    if asyncio.iscoroutine(result):
                        await result
            route.on_message(from_page)
            upstream.on_message(lambda _message: None)

        await lifecycle.install_async(page=page, cdp_session=cdp, http_policy=http_policy,
            websocket_policy=websocket_policy, websocket_pattern=route_pattern)
        await page.goto(local_page_url, wait_until='load')
        await self._open_websocket(page, 'guarded')
        await page.evaluate("""() => {
          window.__captureTimedOut = true;
          setTimeout(() => { window.__guardLifecycleSocket.send('LOOPBACK_GUARDED_DELAYED_BUSINESS'); window.__lateSent = true; }, 100);
        }""")
        await page.wait_for_function('() => window.__lateSent === true', timeout=3000)
        await page.wait_for_timeout(50)
        self.assertEqual(dropped_frames, [True])
        self.assertEqual(self.messages, [])

        result = await lifecycle.finalize_async(page=page, cdp_session=cdp,
            browser_cdp_session=None, quiet_ms=250, max_wait_ms=3000)
        self.assertEqual(result['status'], 'blank_quiet')
        self.assertTrue(result['quietVerified'])
        self.assertTrue(result['guardStillActive'])
        self.assertEqual(page.url, 'about:blank')
        self.assertEqual(await page.evaluate('() => window.name'), role)
        await asyncio.sleep(0.2)
        self.assertEqual(self.messages, [])
        await cdp.detach()

    async def test_real_async_proxy_forwards_control_and_ack_but_drops_business(self):
        local_page_url = f'http://127.0.0.1:{self.http.port}/'
        route_pattern = f'ws://127.0.0.1:{self.ws_port}/**'
        self.messages.clear()
        page = await self.context.new_page()
        role = 'codex-grok-guard-async-proxy-20261006'
        await page.evaluate('(value) => { window.name = value; }', role)
        cdp = await self.context.new_cdp_session(page)
        target_info = await cdp.send('Target.getTargetInfo')
        target_id = target_info.get('targetInfo', {}).get('targetId')
        self.assertTrue(isinstance(target_id, str) and re.fullmatch(r'[A-Fa-f0-9]{32}', target_id))

        role_registry_path = Path(self.temp.name) / 'proxy-page-role-registry.json'
        role_registry_path.write_text(json.dumps({'schemaVersion': 1, 'activePageRoles': {
            role: {'origin': ROLE_ORIGIN, 'selection': 'cdp_target_id', 'exactMarkerCount': 1,
                   'targetId': target_id},
        }}))
        os.chmod(role_registry_path, 0o600)
        activity = GuardActivity()
        lifecycle = OwnedPageGuardLifecycle(role_registry_path=role_registry_path, role=role,
            target_id=target_id, activity=activity)
        controls = []
        acknowledgements = []
        dropped = []

        async def http_policy(route):
            if route.request.method == 'GET' and route.request.url == local_page_url:
                await route.continue_()
            else:
                await route.abort('blockedbyclient')

        async def websocket_policy(route):
            # These statements intentionally use the sync-shaped Playwright calls
            # common to current SDK callbacks. The wrapper must preserve that API.
            upstream = route.connect_to_server()
            if hasattr(upstream, '__await__'):
                upstream = await upstream

            async def from_page(message):
                if message == NATIVE_CONTROL_FRAME:
                    controls.append(message)
                    result = upstream.send(message)
                    if hasattr(result, '__await__'):
                        await result
                else:
                    dropped.append(message)

            async def from_server(message):
                acknowledgements.append(message)
                result = route.send(message)
                if hasattr(result, '__await__'):
                    await result

            route.on_message(from_page)
            upstream.on_message(from_server)

        await lifecycle.install_async(page=page, cdp_session=cdp, http_policy=http_policy,
            websocket_policy=websocket_policy, websocket_pattern=route_pattern)
        await page.goto(local_page_url, wait_until='load')
        await page.evaluate("""({url, control, business}) => new Promise((resolve, reject) => {
          const socket = new WebSocket(url);
          window.__proxySocket = socket;
          const timer = setTimeout(() => reject(new Error('proxy-test-timeout')), 3000);
          socket.addEventListener('open', () => socket.send(control), {once:true});
          socket.addEventListener('message', event => {
            if (event.data === 'LOOPBACK_NATIVE_SESSION_ACK') {
              socket.send(business);
              window.__businessQueued = true;
              clearTimeout(timer);
              resolve(true);
            }
          });
          socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('proxy-test-socket-error')); }, {once:true});
        })""", {'url': f'ws://127.0.0.1:{self.ws_port}/proxy',
             'control': NATIVE_CONTROL_FRAME, 'business': NATIVE_BUSINESS_FRAME})
        await page.wait_for_function('() => window.__businessQueued === true', timeout=3000)
        deadline = asyncio.get_running_loop().time() + 2
        while not dropped and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        self.assertEqual(controls, [NATIVE_CONTROL_FRAME])
        self.assertEqual(acknowledgements, [CONTROL_ACK_FRAME])
        self.assertEqual(dropped, [NATIVE_BUSINESS_FRAME])
        self.assertEqual(self.messages, [NATIVE_CONTROL_FRAME])

        result = await lifecycle.finalize_async(page=page, cdp_session=cdp,
            browser_cdp_session=None, quiet_ms=250, max_wait_ms=3000)
        self.assertEqual(result['status'], 'blank_quiet')
        self.assertTrue(result['guardStillActive'])
        await cdp.detach()


if __name__ == '__main__':
    unittest.main()
