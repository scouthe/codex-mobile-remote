"""Structured web adapter for the installed official UI-Venus mobile agent."""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import signal
import sys

from PIL import Image
import requests
import yaml


def emit(kind, message, **fields):
    print(json.dumps({"type": kind, "message": message, **fields}, ensure_ascii=False), flush=True)


class Stopped(BaseException):
    pass


def interrupted(_signum, _frame):
    # Ignore further stop signals while context managers release the GPU lease.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise Stopped()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    args = parser.parse_args()
    mobile = args.root / 'Venus_framework/Venus_framework_mobile'
    sys.path[:0] = [str(args.root / 'deployment'), str(mobile)]
    os.chdir(mobile)
    adb = os.environ.get('VENUS_ADB_PATH')
    if adb:
        os.environ['PATH'] = str(Path(adb).parent) + os.pathsep + os.environ.get('PATH', '')
    from run_mobile import BROKER, MODEL, model_lease
    from app.run_handler import RunHandler

    request = json.loads((args.run_dir / 'request.json').read_text())
    config = yaml.safe_load((mobile / 'config/ui_venus_2_local.yaml').read_text())
    params = config['policy']['params']
    params['api_key'] = os.environ.get('MIDPLATFORM_TOKEN') or 'EMPTY'
    mapping = yaml.safe_load((mobile / 'config/app_mapping.yaml').read_text())
    if 'app_mapping' in mapping:
        mapping = mapping['app_mapping']
    mapping.setdefault('设置', 'com.android.settings/.Settings')
    lock_path = args.root / 'deployment' / ('device-' + hashlib.sha256(request['deviceId'].encode()).hexdigest()[:16] + '.lock')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    class WebRunHandler(RunHandler):
        final_answer = ''

        def req_from_client(self):
            state = super().req_from_client()
            screenshot = state.get('screenshot_str')
            if screenshot:
                step = self.runtime_context.step
                name = f'preview-{step}.jpg'
                with Image.open(BytesIO(base64.b64decode(screenshot))) as image:
                    image.thumbnail((900, 1400))
                    image.convert('RGB').save(args.run_dir / name, quality=78)
                emit('screen', f'第 {step} 步：查看手机画面', step=step, screenshot=name, status='running')
            return state

        def handle_client_req(self, state):
            result = super().handle_client_req(state)
            action = result[1] or {}
            kind = action.get('action_type', '')
            if not kind:
                (args.run_dir / 'invalid-model-response.json').write_text(
                    json.dumps({'raw_response': result[3], 'action': action}, ensure_ascii=False, indent=2)
                )
                raise RuntimeError('模型没有返回可执行动作，任务已停止。可以换一条更明确的指令重试。')
            names = {'CLK': '点击', 'SWIPE': '滑动', 'INPUT': '输入文字', 'REOPEN': '打开应用',
                     'BACK': '返回', 'WAIT': '等待界面加载', 'PressHome': '返回桌面',
                     'PressMenu': '查看最近应用', 'PressEnter': '确认', 'LongPress': '长按',
                     'DoubleCLK': '双击', 'SUCCESS': '任务完成', 'CallUser': '需要你的反馈'}
            label = names.get(kind, kind or '无法解析动作')
            detail = action.get('app_name') or action.get('input') or ''
            if kind in ('SUCCESS', 'CallUser'):
                self.final_answer = str(action.get('input') or '')
            if detail:
                label += '：' + str(detail)
            emit('action', label, step=self.runtime_context.step, action=action)
            return result

    status = 'failed'
    message = '任务未完成。'
    try:
        with lock_path.open('w') as device_lock:
            try:
                fcntl.flock(device_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('已有其他任务正在操作这台手机，请稍后再试。')
            emit('status', '正在加载本地 Venus 模型，首次启动可能需要一两分钟…', status='loading')
            token = os.environ.get('MIDPLATFORM_TOKEN')
            headers = {'Authorization': f'Bearer {token}'} if token else {}
            # Warm up without creating a lease first. Cancelling a cold start must
            # not leave an allocation whose lease ID the client never received.
            response = requests.get(BROKER + '/api/instances', headers=headers, timeout=5)
            response.raise_for_status()
            instance = next((row for row in response.json()['items']
                             if row['instance_internal_id'] == 'venus_gpu1'), None)
            if not instance or instance['status'] != 'running' or instance['model_name'] != MODEL:
                response = requests.post(BROKER + '/api/instances/venus_gpu1/load',
                                         json={'model_name': MODEL}, headers=headers, timeout=1250)
                if not response.ok:
                    detail = response.json().get('detail', {})
                    raise RuntimeError(detail.get('message', '模型暂时无法加载，请检查 GPU 资源。')
                                       if isinstance(detail, dict) else str(detail))
            with model_lease():
                emit('status', '模型已就绪，开始操作手机。', status='running')
                handler = WebRunHandler(
                    device_id=request['deviceId'], trace_dir=str(args.run_dir / 'traces'),
                    policy_type='ui_venus_2', ep_config={'step_limit': request['stepLimit']},
                    app_mapping=mapping, **params,
                )
                successful, reason, answer = handler.run(purpose=request['purpose'])
                if successful:
                    status, message = 'succeeded', handler.final_answer or '任务已完成。'
                elif reason == 'call_user':
                    status, message = 'needs_input', answer or '需要你的反馈，请在下方补充说明。'
                else:
                    messages = {'max_steps': '已达到步数上限，可以补充指令继续。',
                                'repeat_loop': '多次重复相同动作，任务已停止。',
                                'screenshot_failed': '无法读取手机截图，请检查设备连接。'}
                    message = messages.get(reason, '任务未完成，请检查手机当前界面后重试。')
    except Stopped:
        status, message = 'stopped', '任务已停止。'
    except Exception as error:
        message = str(error)
    emit('result', message, status=status)
    return 0 if status in ('succeeded', 'needs_input', 'stopped') else 1


if __name__ == '__main__':
    raise SystemExit(main())
