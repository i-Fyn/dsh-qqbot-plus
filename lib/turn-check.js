/**
 * 回合结束的漏发检查。
 *
 * 为什么要有它：规则写进系统提示只是「提醒」，我可以忽略；真正能兜住的只有代码。
 * 做法：每轮结束时看这一轮有没有真的调用过「发消息」类工具（qq_confirm send / qq_skip）。
 * 没有就算一次漏发，记下来；下一轮的系统提示最上面会带着这条记录。
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_HOME } from './shared/dirs.js';

const STATE_FILE = join(PLUGIN_HOME, 'turn-check.json');
const MAX_KEEP = 50;

/** 本轮已经发过（内存态，进程重启就清空，不影响计数） */
const spoke = new Set();

function readState() {
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (raw && typeof raw === 'object') {
            return {
                misses: Number(raw.misses) || 0,
                lastMissAt: typeof raw.lastMissAt === 'string' ? raw.lastMissAt : '',
                recent: Array.isArray(raw.recent) ? raw.recent.slice(-MAX_KEEP) : [],
            };
        }
    } catch {
        // 没有文件 / 文件坏了：从零开始，不抛
    }
    return { misses: 0, lastMissAt: '', recent: [] };
}

function writeState(state) {
    try {
        fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {
        // 写不进去也不影响这一轮，下次还会再记
    }
}

/** 这一轮说过话了：qq_confirm(send) 或 qq_skip */
export function markSpoke(sessionId) {
    spoke.add(String(sessionId ?? 'default'));
}

/**
 * 一轮结束：没说过话就记一笔。
 * @returns {{missed: boolean, misses: number}}
 */
export function endTurn(sessionId) {
    const key = String(sessionId ?? 'default');
    const said = spoke.delete(key);
    if (said) return { missed: false, misses: readState().misses };
    const state = readState();
    state.misses += 1;
    state.lastMissAt = new Date().toISOString();
    state.recent.push(state.lastMissAt);
    if (state.recent.length > MAX_KEEP) state.recent = state.recent.slice(-MAX_KEEP);
    writeState(state);
    return { missed: true, misses: state.misses };
}

/** 漏发提示只在「刚漏发」的 10 分钟内出现；过了就返回空，前缀保持逐字不变。 */
const MISS_WINDOW_MS = 10 * 60 * 1000;

/**
 * 给系统提示用的一行。平时返回空字符串——这是有意为之：
 * 文本里任何数字（次数、时间）一变，整段前缀就作废，缓存全白付。
 * 所以只留下「刚漏了一次，这一轮别再漏」这一个语义，且 10 分钟后自动消失。
 */
export function turnCheckText() {
    const state = readState();
    if (!state.lastMissAt) return '';
    const age = Date.now() - Date.parse(state.lastMissAt);
    if (!Number.isFinite(age) || age > MISS_WINDOW_MS) return '';
    return [
        '',
        '### 漏发检查（代码记的，不是提醒）',
        '- 刚才有一轮整轮没发消息。这一轮只要有一句话是冲着对方说的，就先 qq_draft + qq_confirm；不想说话就 qq_skip。',
    ].join('\n');
}

export { STATE_FILE };
