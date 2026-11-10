import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { executable, errorText } from './acp.ts';
import { Conversation } from './conversation.ts';
import { ChatScreen } from './ui.ts';
import { createApprovalReviewer } from './approval.ts';

const ENTRY = 'my-pi-antigravity-session';

function rememberedReference(
  ctx: Pick<ExtensionCommandContext, 'cwd' | 'sessionManager'>,
): { sessionId: string; approvalMode: 'auto' | 'manual' } | undefined {
  const owner = ctx.sessionManager.getSessionId();
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== 'custom' || entry.customType !== ENTRY) continue;
    const data = entry.data;
    if (!data || typeof data !== 'object') continue;
    if (
      'version' in data &&
      data.version === 1 &&
      'owner' in data &&
      data.owner === owner &&
      'cwd' in data &&
      data.cwd === ctx.cwd &&
      'sessionId' in data &&
      typeof data.sessionId === 'string' &&
      data.sessionId.length > 0 &&
      data.sessionId.length <= 1024
    )
      return {
        sessionId: data.sessionId,
        approvalMode: 'approvalMode' in data && data.approvalMode === 'manual' ? 'manual' : 'auto',
      };
  }
  return undefined;
}

export function rememberedSession(
  ctx: Pick<ExtensionCommandContext, 'cwd' | 'sessionManager'>,
): string | undefined {
  return rememberedReference(ctx)?.sessionId;
}

export default function antigravity(pi: ExtensionAPI) {
  let active: ChatScreen | undefined;
  let opening = false;
  pi.registerCommand('antigravity', {
    description: '在 Pi 中打开官方 Antigravity ACP 对话（个人 Google 登录）',
    getArgumentCompletions: (prefix) =>
      ['new', 'login', 'resume']
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('Antigravity ACP 对话需要 Pi 交互界面。', 'error');
        return;
      }
      if (opening || active) {
        ctx.ui.notify('Antigravity 对话已经打开。', 'info');
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify('请先结束当前 Pi 任务，再打开 Antigravity。', 'warning');
        return;
      }
      opening = true;
      let conversation: Conversation | undefined;
      try {
        const command = await executable();
        const input = args.trim();
        const reference = rememberedReference(ctx);
        const saved = input === 'new' ? undefined : reference?.sessionId;
        const initial = ['new', 'login', 'resume'].includes(input) ? '' : input;
        const owner = ctx.sessionManager.getSessionId();
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          conversation = new Conversation(
            ctx.cwd,
            { command, args: ['acp', '--sandbox'] },
            (sessionId) => {
              pi.appendEntry(ENTRY, {
                version: 1,
                owner,
                cwd: ctx.cwd,
                sessionId,
                approvalMode: conversation?.approvalMode ?? 'auto',
              });
            },
            undefined,
            createApprovalReviewer(ctx),
          );
          if (reference) conversation.approvalMode = reference.approvalMode;
          conversation.approvalChanged = () => {
            if (conversation?.sessionId)
              pi.appendEntry(ENTRY, {
                version: 1,
                owner,
                cwd: ctx.cwd,
                sessionId: conversation.sessionId,
                approvalMode: conversation.approvalMode,
              });
          };
          const screen = new ChatScreen(conversation, tui, theme, keys, done);
          active = screen;
          if (initial) screen.enqueueInitial(initial);
          const current = conversation;
          queueMicrotask(() => {
            void current
              .start(saved, input === 'login')
              .then(() => {
                if (input === 'resume' && current.state === 'ready') return screen.resume();
              })
              .catch((error) => current.note(errorText(error)));
          });
          return screen;
        });
      } catch (error) {
        ctx.ui.notify(errorText(error), 'error');
      } finally {
        await conversation?.close();
        active = undefined;
        opening = false;
      }
    },
  });
  pi.on('session_shutdown', async () => {
    await active?.leave();
  });
}
