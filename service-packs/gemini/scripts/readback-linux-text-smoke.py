#!/usr/bin/env python3
"""Independently read back an already-dispatched one-shot Gemini text task."""

import importlib.util
import base64
import json
import re
import urllib.parse
from pathlib import Path
from datetime import datetime

from playwright.sync_api import sync_playwright


REPO = Path(__file__).resolve().parent.parent
SOURCE = Path(__file__).with_name('run-linux-text-smoke.py')
SPEC = importlib.util.spec_from_file_location('gemini_text_smoke_helpers', SOURCE)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError('TEXT_HELPERS_UNAVAILABLE')
HELPERS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPERS)


def safe_failure(code):
    raise HELPERS.SafeFailure(code)


def has_task_marker(value, marker='PROTOCOL42', exact_prompt=HELPERS.PROMPT, depth=0):
    if depth > 24:
        return False
    if isinstance(value, str):
        if exact_prompt in value or marker in value:
            return True
        if value[:1] in {'[', '{'} and len(value) < 2_000_000:
            try:
                return has_task_marker(json.loads(value), marker, exact_prompt, depth + 1)
            except Exception:
                return False
        return False
    if isinstance(value, list):
        return any(has_task_marker(child, marker, exact_prompt, depth + 1) for child in value)
    if isinstance(value, dict):
        return any(has_task_marker(child, marker, exact_prompt, depth + 1) for child in value.values())
    return False


def conversation_ids_in(value, depth=0, out=None):
    if out is None:
        out = set()
    if depth > 24:
        return out
    if isinstance(value, str):
        if re.fullmatch(r'c_[0-9a-f]{16}', value):
            out.add(value)
        elif value[:1] in {'[', '{'} and len(value) < 2_000_000:
            try:
                conversation_ids_in(json.loads(value), depth + 1, out)
            except Exception:
                pass
    elif isinstance(value, list):
        for child in value:
            conversation_ids_in(child, depth + 1, out)
    elif isinstance(value, dict):
        for key, child in value.items():
            if key in {'conversationId', 'conversation_id'} and isinstance(child, str) and re.fullmatch(r'c_[0-9a-f]{16}', child):
                out.add(child)
            conversation_ids_in(child, depth + 1, out)
    return out


def prompt_correlated_api_ids(value, depth=0):
    if depth > 24:
        return set()
    if isinstance(value, str):
        if value[:1] in {'[', '{'} and len(value) < 2_000_000:
            try:
                return prompt_correlated_api_ids(json.loads(value), depth + 1)
            except Exception:
                return set()
        return set()
    if isinstance(value, (list, dict)):
        if has_task_marker(value):
            ids = conversation_ids_in(value)
            if len(ids) == 1:
                return ids
        children = value.values() if isinstance(value, dict) else value
        found = set()
        for child in children:
            found.update(prompt_correlated_api_ids(child, depth + 1))
        return found
    return set()


def main():
    expected_hash, source_sha = HELPERS.read_static_owner_hash()
    owner, _, _ = HELPERS.runtime_and_roles()
    contract = json.loads(HELPERS.CONTRACT_PATH.read_text())
    receipt = json.loads(HELPERS.RECEIPT_PATH.read_text())
    if (receipt.get('taskIntent') != HELPERS.CALLER_INTENT
            or receipt.get('directDispatch', {}).get('count') != 1
            or receipt.get('mutationJournal', {}).get('intentRecordCount') != 1
            or receipt.get('mutationJournal', {}).get('dispatchCount') != 1
            or receipt.get('mutationJournal', {}).get('state') not in {'response_received', 'outcome_unknown', 'reconciled'}):
        safe_failure('ONE_SHOT_READBACK_STATE_INVALID')
    if receipt.get('sourceVerification', {}).get('expectedOwnerSourceSha256') != source_sha:
        safe_failure('EXPECTED_OWNER_SOURCE_SHA_MISMATCH')

    expected_owner = None
    browser = None
    page = None
    cdp = None
    guard_enabled = False
    stage = 'initialization'
    state = {
        'history': None, 'historyCaptures': [], 'detail': None, 'historyByNetwork': {}, 'detailByNetwork': {},
        'documentHeaders': {}, 'expectedApiId': None, 'unknownPosts': 0,
        'unknownAbortFailures': 0, 'unknownPostSummaries': [],
    }
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{int(owner['cdpPort'])}")
            if len(browser.contexts) != 1:
                safe_failure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            core = HELPERS.page_with_marker(context, HELPERS.GEMINI_CORE_ROLE, HELPERS.SERVICE_ORIGIN)
            page = core
            grok = HELPERS.page_with_marker(context, HELPERS.GROK_CORE_ROLE, HELPERS.GROK_ORIGIN)
            if urllib.parse.urlsplit(core.url).path != '/app':
                safe_failure('GEMINI_CORE_PAGE_NOT_BLANK_APP')
            expected_owner = HELPERS.read_grok_owner(grok, expected_hash)
            stage = 'browser_history_capture'

            intent_count, jobs = HELPERS.exact_intent_journal_count(expected_owner)
            if intent_count != 1 or jobs[0].get('dispatchCount') != 1:
                safe_failure('ONE_SHOT_JOURNAL_NOT_UNIQUE')
            journal_already_reconciled = jobs[0].get('state') == 'reconciled'
            if jobs[0].get('state') not in {'response_received', 'outcome_unknown', 'reconciled'}:
                safe_failure('ONE_SHOT_JOURNAL_NOT_PENDING_READBACK')
            prior_windows = [entry for entry in receipt.get('readback', {}).get('historyListComparisons', [])
                             if isinstance(entry.get('timeWindowStartEpoch'), (int, float))
                             and isinstance(entry.get('timeWindowEndEpoch'), (int, float))]
            if journal_already_reconciled and prior_windows:
                window_start = min(entry['timeWindowStartEpoch'] for entry in prior_windows)
                window_end = max(entry['timeWindowEndEpoch'] for entry in prior_windows)
            else:
                try:
                    window_start = datetime.fromisoformat(jobs[0]['createdAt'].replace('Z', '+00:00')).timestamp() - 10
                    window_end = datetime.fromisoformat(jobs[0]['updatedAt'].replace('Z', '+00:00')).timestamp() + 60
                except Exception:
                    safe_failure('ONE_SHOT_JOURNAL_TIME_INVALID')

            cdp = context.new_cdp_session(core)
            cdp.send('Network.enable')
            cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})
            guard_enabled = True

            def continue_request(request_id):
                try: cdp.send('Fetch.continueRequest', {'requestId': request_id})
                except Exception: pass

            def abort_request(request_id):
                try:
                    cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
                    return True
                except Exception:
                    return False

            def on_request(event):
                request = event.get('request') or {}
                url = urllib.parse.urlsplit(request.get('url', ''))
                if url.hostname == 'gemini.google.com' and url.path == '/app' and event.get('type') == 'Document':
                    state['documentHeaders'] = HELPERS.headers_without_credentials(request.get('headers'))

            def on_response(event):
                request_id = event.get('requestId')
                response = event.get('response') or {}
                for table in (state['historyByNetwork'], state['detailByNetwork']):
                    entry = table.get(request_id)
                    if entry:
                        entry['responseStatus'] = int(response.get('status', 0))
                        entry['responseMime'] = str(response.get('mimeType', '')).split(';', 1)[0].strip().lower()
                        entry['encodedBytes'] = int(response.get('encodedDataLength', 0) or 0)

            def on_finished(event):
                request_id = event.get('requestId')
                history_entry = state['historyByNetwork'].get(request_id)
                if history_entry:
                    history_entry['loadingFinished'] = True
                    try:
                        capture = cdp.send('Network.getResponseBody', {'requestId': request_id})
                        raw = base64.b64decode(capture.get('body', '')) if capture.get('base64Encoded') else capture.get('body', '').encode('utf-8')
                        history_entry['responseBase64'] = base64.b64encode(raw).decode('ascii')
                        raw = b''
                    except Exception:
                        history_entry['responseBase64'] = ''
                detail_entry = state['detailByNetwork'].get(request_id)
                if detail_entry:
                    detail_entry['loadingFinished'] = True

            def on_paused(event):
                request = event.get('request') or {}
                request_id = event.get('requestId')
                network_id = event.get('networkId')
                url = request.get('url', '')
                parsed = urllib.parse.urlsplit(url)
                method = str(request.get('method', 'GET')).upper()
                if not request_id:
                    return
                if method in {'GET', 'HEAD', 'OPTIONS'}:
                    continue_request(request_id)
                    return
                body = HELPERS.body_from_paused(cdp, request_id, request)
                headers = HELPERS.headers_without_credentials(request.get('headers'))
                if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com' and parsed.path == HELPERS.DETAIL_PATH and method == 'POST':
                    rpcids = HELPERS.rpc_ids_from_request(url, body)
                    if rpcids == ['MaZiqc']:
                        entry = {'url': url, 'body': body, 'headers': headers, 'networkId': network_id,
                                 'requestId': request_id}
                        state['historyCaptures'].append(entry)
                        if state['history'] is None:
                            state['history'] = entry
                        if network_id:
                            state['historyByNetwork'][network_id] = entry
                        continue_request(request_id)
                        return
                    if rpcids == ['hNvQHb'] and state['expectedApiId']:
                        candidate = HELPERS.parse_expected_detail_request(url, body, state['expectedApiId'])
                        if candidate and state['detail'] is None:
                            state['detail'] = candidate
                            state['detail']['headers'] = headers
                            state['detail']['contentType'] = headers.get('content-type')
                            state['detail']['networkId'] = network_id
                            if network_id:
                                state['detailByNetwork'][network_id] = state['detail']
                            continue_request(request_id)
                            return
                        abort_request(request_id)
                        return
                    if rpcids and all(rpc in HELPERS.READ_RPC_IDS for rpc in rpcids):
                        continue_request(request_id)
                        return
                host = parsed.hostname or ''
                path = parsed.path
                if (host, path) in HELPERS.TELEMETRY or (
                    host in {'gemini.google.com', 'www.google.com', 'www.google-analytics.com', 'analytics.google.com', 'play.google.com'}
                    and (path.startswith('/punctual/') or path.startswith('/$rpc/'))
                ):
                    continue_request(request_id)
                    return
                state['unknownPosts'] += 1
                if not abort_request(request_id):
                    state['unknownAbortFailures'] += 1
                if len(state['unknownPostSummaries']) < 6:
                    state['unknownPostSummaries'].append(HELPERS.safe_post_summary(url, method, headers, body))

            cdp.on('Network.requestWillBeSent', on_request)
            cdp.on('Network.responseReceived', on_response)
            cdp.on('Network.loadingFinished', on_finished)
            cdp.on('Fetch.requestPaused', on_paused)

            core.reload(wait_until='domcontentloaded', timeout=90000)
            core.wait_for_timeout(9000)
            history_captures = state['historyCaptures']
            if not history_captures or not any(entry.get('networkId') for entry in history_captures):
                safe_failure('CURRENT_HISTORY_TEMPLATE_NOT_CAPTURED')
            core.wait_for_timeout(2500)
            valid_history_captures = [entry for entry in history_captures
                                      if entry.get('responseStatus') == 200
                                      and entry.get('responseMime') == 'application/json'
                                      and entry.get('loadingFinished') and entry.get('responseBase64')]
            if not valid_history_captures:
                safe_failure('CURRENT_HISTORY_RESPONSE_NOT_PAIRED')
            if len(valid_history_captures) > 4:
                valid_history_captures = valid_history_captures[:2] + valid_history_captures[-2:]

            # Browser cookies are read once and passed only through Node stdin.
            cookies = context.cookies([HELPERS.SERVICE_ORIGIN])
            allowed = set(contract['auth']['cookieNames'])
            cookie_values = {cookie.get('name'): cookie.get('value') for cookie in cookies
                             if cookie.get('name') in allowed and isinstance(cookie.get('value'), str)}
            if set(cookie_values) != allowed:
                safe_failure('GEMINI_SESSION_COOKIE_SET_INCOMPLETE')

            for operation_name, group in [('identity', state['documentHeaders'])]:
                HELPERS.add_observed_header_names(contract, operation_name, group)
            for capture in valid_history_captures:
                HELPERS.add_observed_header_names(contract, 'history_list', capture['headers'])
            HELPERS.write_contract(contract)

            list_diagnostics = []
            history_context_templates = []
            candidate_ids = set()
            stage = 'direct_history_list'
            for capture_index, history in enumerate(valid_history_captures):
                history_url = urllib.parse.urlsplit(history['url'])
                query_pairs = urllib.parse.parse_qsl(history_url.query, keep_blank_values=True)
                form = HELPERS.parse_form(history['body'])
                parsed = HELPERS.batch_call(history['body'])
                if not parsed or parsed[1] != 'MaZiqc' or not form or 'at' not in form:
                    safe_failure('HISTORY_TEMPLATE_INVALID')
                query = dict(query_pairs)
                if [name for name, _ in query_pairs] != contract['operations']['history_list']['request']['queryKeys']:
                    safe_failure('HISTORY_TEMPLATE_INVALID')
                session = {
                    'version': 1, 'service': contract['service'], 'origin': HELPERS.SERVICE_ORIGIN,
                    'capturedAt': HELPERS.now_iso(),
                    'cookies': [{'name': name, 'value': value} for name, value in cookie_values.items()],
                    'headers': {},
                    'requestHeaders': {
                        'identity': dict(state['documentHeaders']),
                        'history_list': dict(history['headers']),
                    },
                    'batchContext': {
                        'at': form['at'], 'fSid': query['f.sid'], 'buildLabel': query['bl'],
                        'locale': query['hl'], 'requestType': query['rt'], 'sourcePath': query['source-path'],
                        'requestId': query['_reqid'], 'historyListArgs': HELPERS.FIRST_PAGE_HISTORY_ARGS.copy(),
                    },
                }
                history_context_templates.append({
                    'at': form['at'], 'fSid': query['f.sid'], 'buildLabel': query['bl'],
                    'locale': query['hl'], 'requestType': query['rt'], 'sourcePath': query['source-path'],
                    'requestId': query['_reqid'], 'historyListArgs': HELPERS.FIRST_PAGE_HISTORY_ARGS.copy(),
                })
                diagnostic = HELPERS.run_node(
                    [],
                    {
                        'session': session,
                        'expectedOwner': expected_owner,
                        'internalHandoff': True,
                        'taskWindow': {'startEpoch': window_start, 'endEpoch': window_end},
                        'browserObservation': {
                            'url': history['url'], 'method': 'POST',
                            'headers': history['headers'], 'requestBody': history['body'],
                            'status': history.get('responseStatus'), 'contentType': history.get('responseMime'),
                            'responseBase64': history['responseBase64'],
                        },
                    },
                    script=HELPERS.REPO / 'scripts/diagnose-history-list-shape.mjs',
                )
                direct_list = diagnostic.get('direct', {})
                if direct_list.get('ownerMatched') is not True or direct_list.get('anonymousOwnerAbsent') is not True \
                        or direct_list.get('httpStatus') != 200:
                    safe_failure('DIRECT_HISTORY_LIST_OWNER_GATE_FAILED')
                if isinstance(diagnostic.get('apiConversationId'), str):
                    candidate_ids.add(diagnostic['apiConversationId'])
                list_diagnostics.append({
                    'captureIndex': capture_index,
                    'browserStatus': history.get('responseStatus'),
                    'browserBytes': history.get('encodedBytes'),
                    'browserRpcPayloads': diagnostic.get('browser', {}).get('rpcPayloads', []),
                    'directStatus': direct_list.get('httpStatus'),
                    'directBytes': direct_list.get('responseBytes'),
                    'directRpcPayloads': direct_list.get('rpcPayloads', []),
                    'requestComparison': diagnostic.get('requestComparison'),
                    'taskConversationIdCandidateCount': diagnostic.get('taskConversationIdCandidateCount'),
                    'historyArgsSource': 'observed_first_page_template',
                    'timeWindowCandidateCount': diagnostic.get('timeWindowCandidateCount'),
                    'timeWindowStartEpoch': diagnostic.get('timeWindowStartEpoch'),
                    'timeWindowEndEpoch': diagnostic.get('timeWindowEndEpoch'),
                    'candidateSource': diagnostic.get('candidateSource'),
                })
                for cookie in session['cookies']:
                    cookie['value'] = ''
                session['cookies'].clear()
                session['requestHeaders'].clear()
                session['batchContext'].clear()
                history['url'] = ''
                history['body'] = ''
                history['responseBase64'] = ''
                history['headers'].clear()
                diagnostic.clear()
            receipt['readback']['historyListCaptureCount'] = len(valid_history_captures)
            receipt['readback']['historyListComparisons'] = list_diagnostics
            receipt['readback']['targetConversationIdCandidateCount'] = len(candidate_ids)
            receipt['readback']['timeCorrelatedCandidateCount'] = sum(item.get('timeWindowCandidateCount', 0) for item in list_diagnostics)
            receipt['readback']['conversationIdSource'] = next((item.get('candidateSource') for item in list_diagnostics
                                                               if item.get('candidateSource') in {'task_prompt_marker', 'request_time_window'}), 'ambiguous_or_missing')
            if len(candidate_ids) != 1:
                HELPERS.safely_write_receipt(receipt)
                safe_failure('TARGET_CONVERSATION_NOT_UNIQUE_IN_HISTORY')
            api_id = next(iter(candidate_ids))
            if not re.fullmatch(r'c_[0-9a-f]{16}', api_id):
                safe_failure('TARGET_CONVERSATION_ID_SHAPE_INVALID')
            route_id = api_id[2:]
            if len(route_id) != 16:
                safe_failure('TARGET_ROUTE_ID_SHAPE_INVALID')
            state['expectedApiId'] = api_id
            stage = 'browser_detail_capture'
            core.goto(f'{HELPERS.SERVICE_ORIGIN}/app/{route_id}', wait_until='domcontentloaded', timeout=90000)
            core.wait_for_timeout(9000)
            detail = state['detail']
            if not detail or not detail.get('networkId'):
                safe_failure('HISTORY_DETAIL_BROWSER_REQUEST_NOT_CAPTURED')
            core.wait_for_timeout(2000)
            if detail.get('responseStatus') != 200 or detail.get('responseMime') != 'application/json' or not detail.get('loadingFinished'):
                safe_failure('HISTORY_DETAIL_BROWSER_PAIR_INVALID')

            detail_operation = contract['operations']['history_read']
            detail_operation['request']['rpcArgsTemplate'] = detail['rpcArgsTemplate']
            HELPERS.add_observed_header_names(contract, 'history_read', detail['headers'])
            detail_operation['request']['contentType'] = detail['contentType']
            detail_operation['request']['bodyFieldNames'] = detail['bodyFields']
            detail_operation['request']['queryKeys'] = list(detail['query'].keys())
            HELPERS.write_contract(contract)

            context_template = history_context_templates[-1]
            detail_session = {
                'version': 1,
                'service': contract['service'],
                'origin': HELPERS.SERVICE_ORIGIN,
                'capturedAt': HELPERS.now_iso(),
                'cookies': [{'name': name, 'value': value} for name, value in cookie_values.items()],
                'headers': {},
                'requestHeaders': {
                    'identity': dict(state['documentHeaders']),
                    'history_read': dict(detail['headers']),
                },
                'batchContext': {
                    **context_template,
                    'sourcePath': detail['query']['source-path'],
                    'requestId': detail['query']['_reqid'],
                    'locale': detail['query']['hl'],
                    'requestType': detail['query']['rt'],
                },
            }
            stage = 'direct_detail_read'
            detail_args = ['history', 'read', '--envelope-stdin', '--expect-owner', expected_owner]
            if not journal_already_reconciled:
                detail_args.extend(['--caller-intent', HELPERS.CALLER_INTENT])
            detail_result = HELPERS.run_node(
                detail_args,
                {'session': detail_session, 'apiConversationId': api_id, 'visibleRouteId': route_id,
                 'expectedIntent': HELPERS.PROMPT},
            )
            job_count, jobs = HELPERS.exact_intent_journal_count(expected_owner)
            job = jobs[0] if len(jobs) == 1 else {}
            receipt['mutationJournal'] = {
                'intentRecordCount': job_count,
                'dispatchCount': job.get('dispatchCount', 0),
                'state': job.get('state', 'unknown'),
                'resultCategory': 'history_detail_readback' if job.get('state') == 'reconciled' else None,
            }
            receipt['readback'].update({
                'browserPairMatched': True,
                'browserHttpStatus': detail.get('responseStatus'),
                'browserResponseBytes': detail.get('encodedBytes'),
                'directHistoryListStatus': direct_list.get('httpStatus'),
                'targetConversationCount': len(candidate_ids),
                'directDetailStatus': detail_result.get('httpStatus'),
                'directDetailResponseBytes': detail_result.get('responseBytes'),
                'directDetailResponseSha256': detail_result.get('responseSha256'),
                'apiRouteBindingVerified': bool(detail_result.get('apiRouteBindingVerified')),
                'apiIdEchoedInDetail': bool(detail_result.get('apiIdEchoedInDetail')),
                'promptMatched': bool(detail_result.get('promptMatched')),
                'assistantMarkerMatched': bool(detail_result.get('assistantMarkerMatched')),
                'responseIdMatchAvailable': bool(detail_result.get('responseIdMatchAvailable')),
                'responseIdMatched': detail_result.get('responseIdMatched'),
                'detailResponseCount': detail_result.get('detailResponseCount'),
                'ownerMatched': bool(detail_result.get('ownerMatched')),
                'anonymousOwnerAbsent': bool(detail_result.get('anonymousOwnerAbsent')),
            })
            receipt['browserCapture']['readbackAncillaryPostsAborted'] = state['unknownPosts']
            receipt['browserCapture']['readbackAncillaryPostAbortFailures'] = state['unknownAbortFailures']
            complete = (
                detail_result.get('outputStatus') == 'verified'
                and detail_result.get('ownerMatched') is True and detail_result.get('anonymousOwnerAbsent') is True
                and job_count == 1 and job.get('dispatchCount') == 1 and job.get('state') == 'reconciled'
                and state['unknownAbortFailures'] == 0
            )

            # Erase transient session, IDs, request headers, and business data.
            for cookie in session['cookies']:
                cookie['value'] = ''
            session['cookies'].clear()
            session['requestHeaders'].clear()
            session['batchContext'].clear()
            for cookie in detail_session['cookies']:
                cookie['value'] = ''
            detail_session['cookies'].clear()
            detail_session['requestHeaders'].clear()
            detail_session['batchContext'].clear()
            for template in history_context_templates:
                template['at'] = ''
                template['fSid'] = ''
                template['buildLabel'] = ''
                template['historyListArgs'] = []
            history['url'] = ''
            history['body'] = ''
            history['responseBase64'] = ''
            history['headers'].clear()
            detail['url'] = ''
            detail['query'].clear()
            detail['headers'].clear()
            detail_result.clear()
            candidate_ids.clear()
            for captured_history in state['historyCaptures']:
                captured_history['url'] = ''
                captured_history['body'] = ''
                captured_history['responseBase64'] = ''
                captured_history['headers'].clear()
            state['historyCaptures'].clear()
            for name in list(cookie_values):
                cookie_values[name] = ''
            cookie_values.clear()
            state['history'] = None
            state['detail'] = None
            state['historyByNetwork'].clear()
            state['detailByNetwork'].clear()
            state['documentHeaders'].clear()
            state['expectedApiId'] = None
            api_id = None
            route_id = None
            expected_owner = None

            stage = 'quiet_reset'
            core.goto(f'{HELPERS.SERVICE_ORIGIN}/app', wait_until='domcontentloaded', timeout=90000)
            core.wait_for_timeout(3000)
            if urllib.parse.urlsplit(core.url).path != '/app' or state['unknownAbortFailures']:
                safe_failure('QUIET_RESET_NOT_CONFIRMED')
            cdp.send('Fetch.disable')
            guard_enabled = False
            receipt['browserCapture']['quietResetVerified'] = True
            receipt['outcome'] = 'verified' if complete else 'needs_review'
            receipt['observedAt'] = HELPERS.now_iso()
            HELPERS.safely_write_receipt(receipt)
            print(json.dumps({
                'status': receipt['outcome'], 'receipt': str(HELPERS.RECEIPT_PATH),
                'directDetailStatus': receipt['readback']['directDetailStatus'],
                'promptMatched': receipt['readback']['promptMatched'],
                'assistantMarkerMatched': receipt['readback']['assistantMarkerMatched'],
                'conversationIdBound': receipt['readback']['apiRouteBindingVerified'],
                'apiIdEchoedInDetail': receipt['readback']['apiIdEchoedInDetail'],
                'responseIdMatchAvailable': receipt['readback']['responseIdMatchAvailable'],
                'journalState': receipt['mutationJournal']['state'],
            }, separators=(',', ':')))
            return 0 if complete else 1
    except HELPERS.SafeFailure as error:
        receipt['outcome'] = 'needs_review'
        receipt['failureCode'] = error.code
        receipt['readbackStage'] = stage
        receipt['observedAt'] = HELPERS.now_iso()
        if expected_owner:
            try:
                count, jobs = HELPERS.exact_intent_journal_count(expected_owner)
                job = jobs[0] if len(jobs) == 1 else {}
                receipt['mutationJournal'] = {
                    'intentRecordCount': count,
                    'dispatchCount': job.get('dispatchCount', 0),
                    'state': job.get('state', 'unknown'),
                }
            except Exception:
                pass
        HELPERS.safely_write_receipt(receipt)
        print(json.dumps({'status': 'stopped', 'code': error.code,
                          'journalState': receipt['mutationJournal']['state']}, separators=(',', ':')))
        return 2
    except Exception as error:
        receipt['outcome'] = 'needs_review'
        receipt['failureCode'] = 'UNCLASSIFIED_READBACK_FAILURE'
        receipt['failureType'] = type(error).__name__
        receipt['observedAt'] = HELPERS.now_iso()
        try: HELPERS.safely_write_receipt(receipt)
        except Exception: pass
        print(json.dumps({'status': 'stopped', 'code': 'UNCLASSIFIED_READBACK_FAILURE',
                          'failureType': receipt['failureType'], 'readbackStage': stage,
                          'journalState': receipt['mutationJournal']['state']}, separators=(',', ':')))
        return 2
    finally:
        if guard_enabled and owner:
            HELPERS.force_quiet_reset(owner)


if __name__ == '__main__':
    raise SystemExit(main())
