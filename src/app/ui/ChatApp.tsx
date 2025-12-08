/* eslint-disable complexity */
import { useRefFrom } from 'use-ref-from';
import {
  type FormEventHandler,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactEventHandler,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  memo,
  useCallback,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import type { Message } from '../types';

// Good things that I think it's neat and good to keep:
// - Ideas
//    - Every component has imperative ref of `focus()` or `focus({ restoreFocus: boolean })`, calling them will focus on the component.
//       - The component has its own thinking to focus on which subcomponent.
//       - While `HTMLElement.focus()` maybe good enough, to focus on subcomponent, either the caller need to know what to be focused, or the callee need to redirect focus from root.
//    - Every component has `onLeave(reason)` to tell whey they are becoming unfocused, the `reason` could be `"tab"`, `"shift tab"`, `"arrow up"`, etc.
//       - The native `onBlur()` isn't working all the time because it could be `onBlur()` for a split second before `onFocus()` on another subcomponent.
//       - The guess work around "why is the component blurred" is clearer with `onLeave()`.
//    - Look at `onKeyDown[event.key === 'Tab']` to see how focus changes primarily. Use `onFocus()` as auxiliary.
//       - `onKeyDown` is fired before `onFocus`, we can have more controls. Says, we can set `inert` attribute during `onKeyDown` to skip some elements.
//    - UI focus are almost pure `:focus`
//       - Zero DOM change for any focus/selection change, this makes the code much simpler and more performant.
//       - The only UI state that is kept outside of `:focus` is the "focused message ID" (a ref state). Read "why roving tab index doesn't work for us" for more details.
//       - CSS is done by `.chat-history:focus-within:has(.chat-message__body:focus)`.
//       - `:focus` is strictly singular and enforced by the browser, it is impossible to focus on 2 messages at the same time.
// - Techniques
//    - Skip focusing on some content, `onKeyDown[event.key === 'Tab']` temporarily apply `inert` attribute and remove the attribute shortly afterwards (`requestAnimationFrame` works).
//       - Don't apply `inert` permanently as it would disable mouse clicks on elements.
// - Opinions
//    - Roving tab index is great for memorizing recent focused element, but it isn't working for us.
//       - Roving tab index use `tabIndex={0}` to be the cursor of what is last focused. To restore focus, it requires zero JS code.
//       - While press SHIFT-TAB send the focus from send box to the chat history, we will need to skip form controls in the message body and focus directly on the message itself. Roving tab index doesn't work in such scenario.
//       - We borrowed the concept of roving tab index but using focus sentinels to restore the focus. Focus sentinels requires focus redirection, which is expensive in UX sense.
//    - Capture events at the root element of message.
//       - This will centralize the event-driven logic. As a result, simplify some code and makes things easier to debug.
//    - When focused in chat history, makes unselected message transparent, so the end-user has an easier time to see what is selected.

// Notes:
// 1. We cannot use `inert` because it would block mouse clicks as well as TAB.
//    - However, we can use it for temporarily (split second) things.
// 2. Opinion: `stopPropagation` vs. `preventDefault`.
//    The content may not know they are not inside a container, thus, they may not use `stopPropagation` to prevent ancestor from grabbing the event.
//    Instead, content may continue to use `preventDefault` to stop ancestors from knowing the event.
//    Thus, we should use `defaultPrevented` to check if we should handle the event from the content or not.
// 3. Roving tab index is simpler than active descendant
//    - One less DOM element (active descendant requires role="group" while we also need role="feed/article").
//    - CSS styling can simply use `:focus` and `:focus-within`.
// 4. We are using focus sentinels to fake roving tab index
//    - When TAB from outside, all messages except the focused one need to be skipped. This is not trivial.
//       - To achieve this, we need `onKeyDown` watching incoming event.key === 'Tab', when it happen, momentarily add `inert` attribute to all messages except the focused
//       - We cannot have `inert` all the time because it intefere with mouse clicks
//       - The `onKeyDown` need to be set outside of chat history, which is not trivial.
//    - Instead of using singular tabIndex={0}, we remember which message was focused, then the sentinels will directly focus on them.
//       - This is like roving tab index, but the last focused is remembered in code, than remembered via the singular tabIndex={0}.
// 5. NVDA will announce "clickable" when the element has a `onClick` handler, in other words, it don't care if it has `tabIndex={0/-1}` or not.

type ChatHistoryAPI = {
  readonly focus: (init: { which?: 'last message' | undefined }) => void;
};

type ChatMessageAPI = {
  /** When called, focus on the message. */
  readonly focus: (init: { restoreFocus: boolean }) => void;
};

type SendBoxAPI = {
  readonly focus: () => void;
};

const FOCUSABLE_SELECTOR_QUERY = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function getFocusableChildren(element: HTMLElement | null | undefined): readonly HTMLElement[] {
  return Object.freeze(
    Array.from<HTMLElement>(element?.querySelectorAll(FOCUSABLE_SELECTOR_QUERY) ?? []).filter(
      element => !element.closest('[inert]') && element.offsetParent
    )
  );
}

type UseRefAsStateSetterInit = { readonly shouldRenderOnChange: boolean };

function useRefAsState<T>(
  initialValue: T | (() => T)
): readonly [RefObject<T> & { current: T }, (value: SetStateAction<T>, init: UseRefAsStateSetterInit) => void] {
  const [, forceRender] = useState<object>();
  const ref = useRef(typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue);

  const setState = useCallback(
    (value: SetStateAction<T>, init: UseRefAsStateSetterInit): void => {
      const nextValue = typeof value === 'function' ? (value as (prevState: T) => T)(ref.current) : value;

      if (!Object.is(ref.current, nextValue)) {
        ref.current = nextValue;

        init.shouldRenderOnChange && forceRender({});
      }
    },
    [forceRender, ref]
  );

  return [ref, setState];
}

// We use onLeave here to indicate how the user left the message.
// This will make the code simpler. And there are only 1 component to look at when diagnosing key down issues.
const ChatMessage = memo<{
  abstract: string;
  children?: ReactNode | undefined;
  messageId: string;
  onFocus: (messageId: string) => void;
  onLeave: (messageId: string, by: 'arrow down' | 'arrow up' | 'escape' | 'shift tab' | 'tab') => void;
  ref: RefObject<ChatMessageAPI | undefined>;
}>(function ChatMessage({ abstract, children, messageId, onFocus, onLeave, ref }) {
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const headerId = useId();
  const messageIdRef = useRefFrom(messageId);
  const onFocusRef = useRefFrom(onFocus);
  const onLeaveRef = useRefFrom(onLeave);
  const recentFocusableRef = useRef<Element | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);

  const focus = useCallback<ChatMessageAPI['focus']>(
    ({ restoreFocus }) => {
      const { current: body } = bodyRef;
      const { current: recentFocusable } = recentFocusableRef;

      // If the caller request to restore focus, restore the focus back to the focusable if the "recent focusable" is still part of the message.
      if (
        body &&
        restoreFocus &&
        recentFocusable &&
        'focus' in recentFocusable &&
        typeof recentFocusable.focus === 'function' &&
        body.contains(recentFocusable)
      ) {
        recentFocusable.focus();
      } else {
        body?.focus();
      }
    },
    [bodyRef, recentFocusableRef]
  );

  // This is for screen reader only. The header should be invisible and not be clickable by mouse or keyboard.
  // Narrator/NVDA: Press H key to move the virtual cursor to focus on the header, press ENTER.
  //                Screen readers will not fire onClick() when press ENTER on a form control, instead, it will fire onFocus() instead.
  const handleHeaderClick = useCallback<MouseEventHandler<HTMLHeadingElement>>(
    event => {
      if (event.defaultPrevented) {
        return;
      }

      // Don't leak the event to root.onClick.
      event.preventDefault();

      focus({ restoreFocus: false });
    },
    [focus]
  );

  // This is for mouse click and Windows Narrator scan mode click.
  // NVDA: Scan mode, virtual cursor on the text content, press ENTER.
  // Windows Narrator: Will not fire onClick() when press ENTER on message content (not header, not form controls.)
  const handleRootClick = useCallback<MouseEventHandler<HTMLDivElement>>(
    event => {
      if (event.defaultPrevented) {
        return;
      }

      // Windows Narrator: When pressing "H" key to focus on the header and press ENTER, it fire <ChatMessage.root>.onClick, instead of <ChatMessage.header>.onClick.
      //                   Thus, we need to focusBody() instead of focusRoot().
      const { activeElement } = document;
      const { current: body } = bodyRef;

      // If the body is already focused, for example, the <input> inside the body is focused.
      // We should not send the focus back to the body as it would blur <input>.
      if (!(activeElement === body || body?.contains(activeElement))) {
        focus({ restoreFocus: false });
      }
    },
    [bodyRef, focus]
  );

  // Notify chat history this message is being focused. So focus sentinels on chat history will land on this message later.
  // This is for roving tab index without using tabIndex={0}.
  const handleRootFocus = useCallback<ReactEventHandler<HTMLElement>>(() => {
    // Windows Narrator: When pressing H key to jump across messages, by default, Windows Narrator automatically fire `ChatMessage.root.onFocus` event handler.
    //                   The default settings has "Sync the Narrator cursor and system focus" enabled.
    onFocusRef.current?.(messageIdRef.current);

    const { activeElement } = document;
    const { current: body } = bodyRef;

    // Remember what element is focused.
    // When focus back to the message, we restore the focus back to the element.
    recentFocusableRef.current = (body?.contains(activeElement) ? activeElement : body) ?? undefined;
  }, [bodyRef, onFocusRef, messageIdRef, recentFocusableRef]);

  const handleRootKeyDown = useCallback<KeyboardEventHandler<unknown>>(
    event => {
      if (event.defaultPrevented) {
        return;
      }

      const { current: body } = bodyRef;
      const { current: messageId } = messageIdRef;
      const { target } = event;

      const isTargetingBody = target === body;

      switch (event.key) {
        case 'ArrowDown':
          // DOWN ARROW from the message should go to next message.
          isTargetingBody && onLeaveRef.current?.(messageId, 'arrow down');

          break;

        case 'ArrowUp':
          // UP ARROW from the message should go to previous message.
          isTargetingBody && onLeaveRef.current?.(messageId, 'arrow up');

          break;

        case 'Enter':
          if (isTargetingBody) {
            // ENTER from the body should focus on form control, if available.
            getFocusableChildren(body)[0]?.focus();
          }

          break;

        case 'Escape':
          if (isTargetingBody) {
            // ESCAPE from the message should leave the message.
            onLeaveRef.current?.(messageId, 'escape');
          } else {
            // ESCAPE from form control should focus on the message itself.
            focus({ restoreFocus: false });
          }

          break;

        case 'Tab':
          if (body && target) {
            if (event.shiftKey && target === body) {
              // SHIFT-TAB from the message should leave the message.
              onLeaveRef.current?.(messageId, 'shift tab');
            } else {
              const focusables = getFocusableChildren(body);

              // TAB from the last form control should leave the message.
              // TAB from a message without form control should leave the message.
              if (!event.shiftKey && (!focusables.length || target === focusables.at(-1))) {
                onLeaveRef.current?.(messageId, 'tab');
              }
            }
          }

          break;
      }
    },
    [bodyRef, focus, onLeaveRef]
  );

  useImperativeHandle<ChatMessageAPI | undefined, ChatMessageAPI>(ref, () => Object.freeze({ focus }), [focus]);

  return (
    <article // Required: children of role="feed" must be role="article".
      aria-labelledby={bodyId} // Required: we just want screen reader to narrate header. Without this, it will narrate the whole content.
      className="chat-message"
      data-testid="chat message"
      onClick={handleRootClick}
      onFocus={handleRootFocus}
      onKeyDown={handleRootKeyDown}
      ref={rootRef}
    >
      <h1
        className="chat-message__header"
        id={headerId}
        onClick={handleHeaderClick} // This onClick is for screen reader only.
      >
        {abstract}
      </h1>
      <div
        // This element serve a single purpose, ability to programmatically focus on this element. I.e. set tabIndex={-1} then call focus(), revert on blur.
        // Perhaps, we can componentize it out as <ManualFocusable> component.
        aria-labelledby={bodyId} // Narrator quirks: without aria-labelledby, after pressing ENTER and focus on this element, Windows Narrator will say nothing.
        className="chat-message__body"
        data-testid="chat message body"
        ref={bodyRef}
        tabIndex={0}
      >
        {children}
      </div>
    </article>
  );
});

function ChatHistory({
  messages,
  onLeave,
  ref
}: {
  readonly messages: readonly Message[];
  readonly onLeave: (how: 'arrow down' | 'arrow up' | 'escape') => void;
  readonly ref: RefObject<ChatHistoryAPI | undefined>;
}) {
  // Message ID is the source-of-truth of the focused message.
  // - We tried using SoT of ChatMessage API ref, however, it is only available after rendering, i.e. useEffect, not great.
  // - We tried using SoT of message index, it cannot survive message insertions.
  const [focusedMessageIdRef, setFocusedMessageIDRef] = useRefAsState<string | undefined>(undefined);
  const messageAPIMapRef = useRef<Map<string, RefObject<ChatMessageAPI>>>(new Map());
  const messagesRef = useRefFrom(messages);
  const onLeaveRef = useRefFrom(onLeave);
  const rootRef = useRef<HTMLDivElement>(null);

  const focus = useCallback<ChatHistoryAPI['focus']>(
    ({ which }) => {
      const messageIdToFocus =
        (which !== 'last message' ? focusedMessageIdRef.current : undefined) ?? messagesRef.current?.at(-1)?.id;

      messageIdToFocus && messageAPIMapRef.current.get(messageIdToFocus)?.current?.focus({ restoreFocus: false });
    },
    [messageAPIMapRef, messagesRef]
  );

  useMemo(() => {
    const { activeElement } = document;
    const { current: root } = rootRef;

    // Explicitly move the focus to newly added message when "messages" props changed while the chat history is not focused.
    if (!root?.contains(activeElement)) {
      focusedMessageIdRef.current = messages.at(-1)?.id;
    }

    // Compile `messageAPIMapRef` so we can call <ChatMessage> API later.
    const nextMessageIds = new Set(messages.map(({ id }) => id));
    const messageIds = new Set(messageAPIMapRef.current.keys());

    for (const id of nextMessageIds.difference(messageIds)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messageAPIMapRef.current.set(id, { current: undefined } as any);
    }

    for (const id of messageIds.difference(nextMessageIds)) {
      messageAPIMapRef.current.delete(id);
    }
  }, [focusedMessageIdRef, messageAPIMapRef, messages, rootRef]);

  const jumpToRelativeMessage = useCallback(
    (messageId: string, relativePosition: number): number => {
      const index = messagesRef.current?.findIndex(({ id }) => id === messageId);
      const messagesLength = messagesRef.current.length;
      let nextIndex: number;

      if (!~index) {
        // If the current message is no longer available, focus on the very last message.
        nextIndex = messagesLength - 1;
      } else if (index + relativePosition < 0) {
        // If there are no previous message to jump to, return -Infinity.
        return -Infinity;
      } else if (index + relativePosition >= messagesLength) {
        // If there are no next message to jump to, return Infinity.
        return Infinity;
      } else {
        nextIndex = index + relativePosition;
      }

      const nextFocusedMessageId = messagesRef.current?.at(nextIndex)?.id;

      setFocusedMessageIDRef(nextFocusedMessageId, { shouldRenderOnChange: false });

      messageAPIMapRef.current.get(nextFocusedMessageId as string)?.current?.focus({ restoreFocus: false });

      return nextIndex;
    },
    [messageAPIMapRef, messagesRef, setFocusedMessageIDRef]
  );

  const handleFocusSentinelFocus = useCallback(() => {
    const { current: focusedMessageId } = focusedMessageIdRef;

    focusedMessageId && messageAPIMapRef.current.get(focusedMessageId)?.current?.focus({ restoreFocus: true });
  }, [focusedMessageIdRef, messageAPIMapRef]);

  // Remember which message is being focused, we need this for TAB-ing from outside (i.e. focus sentinels.)
  // This function is hot path. If the message contains multiple <input>, switching <input> will send them here.
  const handleMessageFocus = useCallback(
    (id: string) => setFocusedMessageIDRef(id, { shouldRenderOnChange: false }),
    [setFocusedMessageIDRef]
  );

  const handleMessageLeave = useCallback(
    (messageId: string, by: 'arrow down' | 'arrow up' | 'escape' | 'shift tab' | 'tab') => {
      if (by === 'arrow down') {
        if (jumpToRelativeMessage(messageId, 1) === Infinity) {
          // If there are no next message to jump to, focus on the send box.
          onLeaveRef.current?.('arrow down');
        }
      } else if (by === 'arrow up') {
        if (jumpToRelativeMessage(messageId, -1) === -Infinity) {
          // If there are no previous message to jump to, fire onLeave().
          onLeaveRef.current?.('arrow up');
        }
      } else if (by === 'shift tab' || by === 'tab') {
        // When SHIFT-TAB or TAB key is pressed to focus out of chat history, skip all message bodies, so TAB will naturally land on the next focusable.
        rootRef.current?.setAttribute('inert', '');

        requestAnimationFrame(() => rootRef.current?.removeAttribute('inert'));
      } else {
        // When ESCAPE key is pressed on the message, jump to send box.
        // If this is not desirable, the content component should call `event.preventDefault()` to prevent this behavior.
        by satisfies 'escape';

        onLeaveRef.current?.('escape');
      }
    },
    [jumpToRelativeMessage, onLeaveRef, rootRef]
  );

  useImperativeHandle<ChatHistoryAPI | undefined, ChatHistoryAPI>(ref, () => Object.freeze({ focus }), [focus]);

  return (
    <section
      className="chat-history"
      data-testid="chat history"
      ref={rootRef}
      role="feed" // Required: we are using role="feed/article" to represent the chat thread.
    >
      <div className="focus-sentinel" onFocus={handleFocusSentinelFocus} role="none" tabIndex={0} />
      {messages.map(message => (
        <ChatMessage
          abstract={message.abstract}
          key={message.id}
          messageId={message.id}
          onFocus={handleMessageFocus}
          onLeave={handleMessageLeave}
          ref={messageAPIMapRef.current.get(message.id)!}
        >
          {message.children}
        </ChatMessage>
      ))}
      <div
        aria-hidden // Required: Compare to role="none/presentation", only aria-hidden will hide the element from reading.
        className="focus-sentinel"
        onFocus={handleFocusSentinelFocus}
        tabIndex={0}
      />
    </section>
  );
}

const SendBox = memo<{
  readonly onLeave: (by: 'arrow up') => void;
  readonly ref: RefObject<SendBoxAPI | undefined>;
}>(function SendBox({ onLeave, ref }) {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const focus = useCallback(() => textAreaRef.current?.focus(), [textAreaRef]);

  const onLeaveRef = useRefFrom(onLeave);

  const handleKeyDown = useCallback<KeyboardEventHandler<HTMLTextAreaElement>>(
    event => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === 'ArrowUp' && event.currentTarget.selectionEnd === 0) {
        onLeaveRef.current?.('arrow up');
      }
    },
    [onLeaveRef]
  );

  const handleSubmit = useCallback<FormEventHandler<HTMLFormElement>>(event => event.preventDefault(), []);

  useImperativeHandle(ref, () => Object.freeze({ focus }), [focus]);

  return (
    <form className="send-box" data-testid="send box" onSubmit={handleSubmit}>
      <textarea
        autoFocus={true}
        className="send-box__text-box"
        data-testid="send box text box"
        onKeyDown={handleKeyDown}
        placeholder="Type a message"
        ref={textAreaRef}
      />
    </form>
  );
});

const ChatApp = memo<{ messages: readonly Message[] }>(function ChatApp({ messages }) {
  const chatHistoryRef = useRef<ChatHistoryAPI>(undefined);
  const sendBoxRef = useRef<SendBoxAPI>(undefined);

  const handleChatHistoryLeave = useCallback(
    (by: 'arrow down' | 'arrow up' | 'escape') => {
      if (by === 'arrow down' || by === 'escape') {
        sendBoxRef.current?.focus();
      }
    },
    [sendBoxRef]
  );
  const handleSendBoxLeave = useCallback(
    (by: 'arrow up') => {
      if (by === 'arrow up') {
        chatHistoryRef.current?.focus({ which: 'last message' });
      }
    },
    [chatHistoryRef]
  );

  return (
    <div className="chat-app" data-testid="chat app">
      <ChatHistory messages={messages} onLeave={handleChatHistoryLeave} ref={chatHistoryRef} />
      <SendBox onLeave={handleSendBoxLeave} ref={sendBoxRef} />
    </div>
  );
});

export default ChatApp;
