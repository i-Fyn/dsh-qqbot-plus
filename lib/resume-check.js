/**
 * 重启接话检查（工具式）。
 *
 * 为什么不往会话里注一段文字了：
 *  - 那段注入是「用户消息」，每重启一次就在历史里多一段，而且它会去找
 *    最后一次入站的那条会话——那条常常是旧的（群、或者早就不用的私聊），
 *    于是「一直会找到旧的会话」。
 * 做法：
 *  - 宿主启动时只在本地记一个「待检查」标记（不碰任何会话）；
 *  - 系统提示里多一行：刚重启过就先调 qq_resume_check。调完这行就消失；
 *  - 真正的内容（上次停机多久、对方最后说了什么、需不需要接话）
 *    由 qq_resume_check 的工具回执给出。
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_HOME } from './shared/dirs.js';
import { writeJsonAtomic } from './shared/json-file.js';

const STATE_FILE = join(PLUGIN_HOME, 'resume-check.json');

/** 超过这个时长还没被读，这条提醒就作废（免得隔天开机还在提醒昨天的事）。 */
const WINDOW_MS = 6 * 3600 * 1000;

/** 多短才不算一次重启：启动本身就要几秒，别拿 5 秒吓自己（11-20 那次 4.4 秒被跳过）。 */
export const MIN_RESTART_GAP_MS = 500;

function readState() {
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (raw && typeof raw === 'object') return raw;
    } catch {
        // 没有文件 / 文件坏了：当作没有待检查
    }
    return {};
}

function writeState(state) {
    try {
        fs.mkdirSync(PLUGIN_HOME, { recursive: true });
        writeJsonAtomic(STATE_FILE, state);
    } catch {
        // 写不进去不影响收发，下次开机还会再挂
    }
}

/**
 * 宿主启动时调用：记一个待检查标记。不往任何会话投递内容。
 * @param {{gapMs:number, lastInbound?:object|null, lastTarget?:object|null}} info
 */
export function armResumeCheck(info) {
    const gap = Number(info?.gapMs) || 0;
    if (gap < MIN_RESTART_GAP_MS) return false;
    const inbound = info?.lastInbound ?? null;
    writeState({
        armedAt: new Date().toISOString(),
        gapMs: gap,
        lastInbound: inbound === null ? null : {
            scope: typeof inbound.scope === 'string' ? inbound.scope : '',
            peerId: typeof inbound.peerId === 'string' ? inbound.peerId : '',
            senderId: typeof inbound.senderId === 'string' ? inbound.senderId : '',
            at: typeof inbound.at === 'string' ? inbound.at : '',
            text: String(inbound.text ?? '').slice(0, 300),
        },
        lastTarget: info?.lastTarget ?? null,
        readAt: '',
    });
    return true;
}

/** 还在窗口内、且没被读过的那条待检查；否则 null。 */
export function pendingResume() {
    const state = readState();
    if (!state.armedAt || state.readAt) return null;
    const age = Date.now() - Date.parse(state.armedAt);
    if (!Number.isFinite(age) || age < 0 || age > WINDOW_MS) return null;
    return state;
}

/** 读完就销账（只读不消费会在前缀里一直挂着）。 */
export function consumeResume() {
    const state = readState();
    if (!state.armedAt) return;
    writeState({ ...state, readAt: new Date().toISOString() });
}

/**
 * 系统提示里那一行。平时返回空串——这是有意的：前缀要逐字稳定，
 * 只有真的「刚重启、还没检查」时才多这一行，调完工具立刻恢复原样。
 */
export function resumeCheckText() {
    if (!pendingResume()) return '';
    return [
        '',
        '### 接话检查（宿主刚重启）',
        '- 先调 qq_resume_check：看上一轮对方有没有还没回的话、停了多久。有就接着做完再回话，没有就 qq_skip。',
    ].join('\n');
}

/** 工具回执的内容。 */
export function resumeCheckPayload() {
    const state = pendingResume();
    if (!state) {
        return {
            restarted: false,
            hint: '没有待检查的重启记录（可能是刚检查过，或者这次是正常启动）。',
        };
    }
    const info = state.lastInbound ?? null;
    const age = info?.at ? Date.now() - Date.parse(info.at) : null;
    const recent = Number.isFinite(age) && age >= 0 && age <= 12 * 3600 * 1000;
    return {
        restarted: true,
        stoppedForMs: Number(state.gapMs) || 0,
        lastInbound: info,
        lastInboundRecent: recent,
        hint: recent && info?.text
            ? '对方最后说的那句话在上面 lastInbound.text 里；需要回就 qq_draft + qq_confirm，不用就 qq_skip。'
            : '没有窗口内的最后一条消息，自己看这轮上下文决定要不要说话。',
    };
}

export { STATE_FILE };
