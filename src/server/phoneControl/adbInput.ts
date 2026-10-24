import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PhoneInput, PhonePoint, PhoneVideoFormat } from '../../types/phoneControl.js'
import { PhoneAgentError } from '../phoneHttp.js'

const exec = promisify(execFile)
const keys = { back: 4, home: 3, recent: 187, enter: 66, delete: 67, wake: 224 } as const

function point(value: unknown): asserts value is PhonePoint {
  const p = value as PhonePoint | undefined
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
    throw new PhoneAgentError('操作坐标不正确。')
  }
}

/** Validates the whole command before any ADB call; never accepts arbitrary shell text. */
export function validatePhoneInput(value: unknown): PhoneInput {
  const input = value as PhoneInput | undefined
  if (!input || typeof input !== 'object') throw new PhoneAgentError('操作格式不正确。')
  if (input.type === 'tap' || input.type === 'swipe') {
    if (!Number.isInteger(input.epoch) || input.epoch < 1) throw new PhoneAgentError('请等待实时画面。')
    if (input.type === 'tap') point(input.point)
    else {
      point(input.from); point(input.to)
      if (!Number.isInteger(input.duration) || input.duration < 50 || input.duration > 2000) throw new PhoneAgentError('滑动时长范围为 50–2000 毫秒。')
    }
  } else if (input.type === 'key') {
    if (!Object.prototype.hasOwnProperty.call(keys, input.key)) throw new PhoneAgentError('不支持此按键。')
  } else if (input.type === 'text') {
    if (typeof input.text !== 'string' || !input.text.length || input.text.length > 2000) throw new PhoneAgentError('请输入 1–2000 字。')
  } else throw new PhoneAgentError('不支持此操作。')
  return input
}

export class PhoneAdbInput {
  constructor(private readonly adb: string, private readonly deviceId: string) {}

  private async shell(args: string[]): Promise<string> {
    const result = await exec(this.adb, ['-s', this.deviceId, 'shell', ...args], { timeout: 7000, maxBuffer: 2 * 1024 * 1024 })
    return result.stdout
  }

  async execute(input: PhoneInput, format?: PhoneVideoFormat): Promise<void> {
    validatePhoneInput(input)
    if (input.type === 'key') { await this.shell(['input', 'keyevent', String(keys[input.key])]); return }
    if (input.type === 'text') {
      const ime = await this.shell(['settings', 'get', 'secure', 'default_input_method'])
      if (ime.trim() !== 'com.android.adbkeyboard/.AdbIME') throw new PhoneAgentError('请先将手机输入法切换为 ADB Keyboard。', 409)
      await this.shell(['am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(input.text, 'utf8').toString('base64')])
      return
    }
    if (!format || format.epoch !== input.epoch) throw new PhoneAgentError('画面方向已变化，请等待最新画面后重试。', 409)
    // Logical display coordinates already account for rotation and resolution overrides.
    const display = await this.shell(['dumpsys', 'input'])
    const viewport = /Viewport INTERNAL:[^\n]*displayId=0[^\n]*logicalFrame=\[0,\s*0,\s*(\d+),\s*(\d+)\]/.exec(display)
    if (!viewport) throw new PhoneAgentError('无法确认手机当前屏幕尺寸，请重新接管。', 409)
    const width = Number(viewport[1]), height = Number(viewport[2])
    if ((width > height) !== (format.width > format.height)) throw new PhoneAgentError('手机正在旋转，请等待画面更新后重试。', 409)
    const pixels = (p: PhonePoint) => [String(Math.round(p.x * (width - 1))), String(Math.round(p.y * (height - 1)))]
    const args = input.type === 'tap' ? ['tap', ...pixels(input.point)] : ['swipe', ...pixels(input.from), ...pixels(input.to), String(input.duration)]
    await this.shell(['input', ...args])
  }
}
