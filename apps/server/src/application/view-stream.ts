import type { AttachedReplicatedState } from "@earendil-works/chord";
import type { Conversation, ConversationView } from "@earendil-works/pi-durable";
import type { ConversationView as ClientView } from "@assistant/contracts";
import type { AppContext } from "./context.js";
import type { createViews } from "./views.js";
import { Index } from "@assistant/runtime";
import { DesktopTranscript } from "../desktop-conversations.js";

export function watchView(context: AppContext, views: ReturnType<typeof createViews>, conversation: Conversation, send: (view: ClientView) => Promise<void>, onError: (error: unknown) => void) {
  let closed = false, pushing = false, dirty = false;
  let view: AttachedReplicatedState<ConversationView> | undefined;
  let unsubscribe: (() => void) | undefined, unsubscribeGraph: (() => void) | undefined;
  let unsubscribeIndex: (() => void) | undefined, disposeIndex: (() => void) | undefined;
  let unsubscribeDesktop: (() => void) | undefined, disposeDesktop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    unsubscribe?.(); unsubscribeGraph?.(); unsubscribeIndex?.(); disposeIndex?.(); unsubscribeDesktop?.(); disposeDesktop?.(); view?.dispose();
  }
  async function push() {
    timer = undefined;
    if (closed || !view) return;
    if (pushing) { dirty = true; return; }
    pushing = true;
    try {
      do {
        dirty = false;
        const payload = await views.simplifyView(conversation.id, view.value);
        if (closed) return;
        await send(payload);
      } while (dirty && !closed);
    } catch (error) { close(); onError(error); }
    finally { pushing = false; }
  }
  const schedule = () => { if (!closed && !timer) timer = setTimeout(() => void push(), 150); };
  const ready = (async () => {
    view = await conversation.viewState(context.ctx);
    if (closed) { view.dispose(); return; }
    unsubscribe = view.subscribe(schedule);
    unsubscribeGraph = context.taskGraph.subscribe(schedule);
    const desktop = await context.harness.documentState(DesktopTranscript, conversation.id, context.ctx);
    if (closed) { desktop?.dispose(); return; }
    if (desktop) { unsubscribeDesktop = desktop.subscribe(schedule); disposeDesktop = () => desktop.dispose(); }
    const index = await context.harness.documentState(Index, context.ctx);
    if (closed) { index?.dispose(); return; }
    if (index) { unsubscribeIndex = index.subscribe(schedule); disposeIndex = () => index.dispose(); }
    await push();
  })().catch(error => { close(); onError(error); });
  return { close, ready };
}
