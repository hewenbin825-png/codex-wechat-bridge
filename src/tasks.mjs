import { summary } from './common.mjs';

export function clearCommand(raw) {
  let text=String(raw).trim();
  if(/^[（(]\s*\/[\s\S]*[）)]$/.test(text))text=text.slice(1,-1).trim();
  if(!/^\/clear(?:\s|$)/i.test(text))return null;
  return /^\/clear$/i.test(text)?{clear:true}:{error:'清理题号和任务号请单独发送 /clear；工作聊天与历史保留。'};
}

// A slash is mandatory: ordinary question answers never enter this parser.
export function continuationCommand(raw, tasks) {
  let text = String(raw).trim();
  if (/^[（(]\s*\/[\s\S]*[）)]$/.test(text)) text = text.slice(1, -1).trim();
  if (!text.startsWith('/')) return null;
  if(clearCommand(text))return {error:' /clear 是清理题号和任务号的保留命令，不作为任务续办提示词。'};
  const body = text.slice(1).trim();
  if (['任务', '任务列表', 'tasks'].includes(body)) return { list: true };
  if (!body) return { error: '请发送「/任务号 下一步要求」，例如 /1 继续任务。' };
  const numbered = /^(\d+)(?:\s+([\s\S]+))?$/.exec(body);
  let task, prompt;
  if (numbered) {
    task = tasks.find(t => t.number === Number(numbered[1])); prompt = numbered[2]?.trim();
    if (!task) return { error: '没有这个任务号。发送「/任务」查看任务列表。' };
    if (!prompt) return { error: `请在任务号后写下一步要求，例如 /${task.number} 继续任务。` };
  } else {
    const available = tasks.filter(t => t.state === 'completed');
    if (available.length !== 1) return { error: available.length ? `多个任务可以续办，请指定任务号。\n${taskList(available)}` : '当前没有可以续办的已完成主任务。发送「/任务」查看。' };
    [task] = available; prompt = body;
  }
  if (task.state !== 'completed') return { error: `任务 ${task.number} 当前${task.state === 'uncertain' ? '的上次投递结果待核对，请先查看原聊天' : '正在处理，请等待本轮结束'}。` };
  if (!prompt || prompt.length > 8000) return { error: '下一步要求应为 1–8000 个字符。' };
  return { task, prompt };
}

export function taskList(tasks) {
  if (!tasks.length) return '当前还没有已记录的主任务。';
  const states = { completed: '可续办', queued: '待投递', active: '处理中', uncertain: '投递待核对', archived: '已归档' };
  return tasks.slice(-30).reverse().map(t => `任务 ${t.number}｜${summary(t.title, 40)}（${states[t.state] || t.state}）`).join('\n')
    + '\n发送「/任务号 下一步要求」，例如 /1 继续任务。';
}
