/* eslint-disable complexity */
import classNames from 'classnames';
import { useRefFrom } from 'use-ref-from';
import {
  type FormEventHandler,
  type KeyboardEventHandler,
  type MouseEventHandler,
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

type ChatHistoryAPI = {
  readonly focus: (init: { which: 'last message' }) => void;
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

// We have onJumpToNext, onJumpToPrevious, onLeave here, instead of capturing `onKeyDown(ArrowUp/ArrowDown/Tab/Escape)` at chat history.
// This will make the code simpler. And there are only 1 component to look at when diagnosing key down issues.
// It will make <ChatMessage> more complex. But the <ChatHistory> become very simple then.
const ChatMessage = memo<{
  abstract: string;
  children?: ReactNode | undefined;
  messageId: string;
  onFocus: (messageId: string) => void;
  onJumpToNext: (messageId: string) => void;
  onJumpToPrevious: (messageId: string) => void;
  onLeave: (messageId: string, by: 'escape' | 'shift tab' | 'tab') => void;
  ref: RefObject<ChatMessageAPI | undefined>;
}>(function ChatMessage({ abstract, children, messageId, onFocus, onJumpToNext, onJumpToPrevious, onLeave, ref }) {
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const headerId = useId();
  const messageIdRef = useRefFrom(messageId);
  const onFocusRef = useRefFrom(onFocus);
  const onJumpToNextRef = useRefFrom(onJumpToNext);
  const onJumpToPreviousRef = useRefFrom(onJumpToPrevious);
  const onLeaveRef = useRefFrom(onLeave);
  const recentFocusableRef = useRef<Element | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);

  const focus = useCallback(
    ({ restoreFocus }: { restoreFocus: boolean }) => {
      const { current: body } = bodyRef;
      const { current: recentFocusable } = recentFocusableRef;

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

  // This is for screen reader only. The header should be visually sized 0px x 0px and it should not be clickable by mouse or keyboard.
  // Windows Narrator quirks: In scan mode, press H key to put virtual cursor on the header, then press ENTER key.
  //                          It should fire header.onClick. However, fire root.onClick instead and never header.onClick.
  //                          We are not sure why it happens this way, even we set <header tabIndex={0}>, it still fire root.onClick.
  const handleHeaderClick = useCallback<MouseEventHandler<HTMLHeadingElement>>(
    event => {
      // Don't leak the event to root.onClick.
      event.stopPropagation();

      focus({ restoreFocus: false });
    },
    [focus]
  );

  // This is for mouse click and Windows Narrator scan mode click.
  const handleRootClick = useCallback<MouseEventHandler<HTMLDivElement>>(() => {
    // Windows Narrator: When pressing "H" key to focus on the header and press ENTER, it fire <ChatMessage.root>.onClick, instead of <ChatMessage.header>.onClick.
    //                   Thus, we need to focusBody() instead of focusRoot().
    const { activeElement } = document;
    const { current: body } = bodyRef;

    // If the body is already focused, for example, the <input> inside the body is focused.
    // We should not send the focus back to the body as it would blur <input>.
    if (!(activeElement === body || body?.contains(activeElement))) {
      focus({ restoreFocus: false });
    }
  }, [bodyRef, focus]);

  // Notify chat history this message is being focused. So focus sentinels will land on this message later.
  // This is actually roving tab index without using tabIndex={0}.
  const handleRootFocus = useCallback(() => {
    // Windows Narrator: when pressing H key to jump across messages, it automatically fire <ChatMessage.root>.onFocus automatically.
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
        case 'ArrowUp':
          isTargetingBody && onJumpToPreviousRef.current?.(messageId);

          break;

        case 'ArrowDown':
          isTargetingBody && onJumpToNextRef.current?.(messageId);

          break;

        case 'Enter':
          if (isTargetingBody) {
            getFocusableChildren(body)[0]?.focus();
          }

          break;

        case 'Escape':
          if (isTargetingBody) {
            onLeaveRef.current?.(messageId, 'escape');
          } else {
            focus({ restoreFocus: false });
          }

          break;

        case 'Tab':
          if (body && target) {
            if (event.shiftKey && target === body) {
              onLeaveRef.current?.(messageId, 'shift tab');
            } else {
              const focusables = getFocusableChildren(body);

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

  useImperativeHandle(ref, () => Object.freeze({ focus }), [focus]);

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
        onClick={handleHeaderClick}
        // Windows Narrator quirks: All scan mode item must have `tabIndex`. Otherwise it may send the focus to `document.body`.
        tabIndex={-1}
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
  readonly onLeave: (how: 'down arrow' | 'escape') => void;
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

  const focus = useCallback<(focusInit: { which?: 'last message' | undefined }) => void>(
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
        nextIndex = messagesLength - 1;
      } else if (index + relativePosition < 0) {
        return -Infinity;
      } else if (index + relativePosition >= messagesLength) {
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

  const handleMessageJumpToNext = useCallback(
    (messageId: string) => {
      if (jumpToRelativeMessage(messageId, 1) === Infinity) {
        onLeaveRef.current?.('down arrow');
      }
    },
    [jumpToRelativeMessage, onLeaveRef]
  );

  const handleMessageJumpToPrevious = useCallback(
    (messageId: string) => jumpToRelativeMessage(messageId, -1),
    [jumpToRelativeMessage]
  );

  const handleMessageLeave = useCallback(
    (_: string, by: 'escape' | 'shift tab' | 'tab') => {
      if (by === 'shift tab' || by === 'tab') {
        // When tabbing out of chat history, skip all message bodies so TAB naturally land to the next focusable.
        rootRef.current?.setAttribute('inert', '');

        requestAnimationFrame(() => rootRef.current?.removeAttribute('inert'));
      } else {
        // When ESCAPE key is pressed on the message, jump to send box.
        by satisfies 'escape';
        onLeaveRef.current?.('escape');
      }
    },
    [onLeaveRef]
  );

  useImperativeHandle(ref, () => Object.freeze({ focus }), [focus]);

  return (
    <section
      className={classNames('chat-history', {
        'chat-history--interact-mode-2': true
      })}
      data-testid="chat history"
      ref={rootRef}
      role="feed" // Required: we are using role="feed/article" to represent the chat thread.
    >
      <div className="focus-sentinel" onFocus={handleFocusSentinelFocus} role="none" tabIndex={0} />
      {messages.map(message => (
        <ChatMessage
          abstract={message.abstract}
          messageId={message.id}
          onFocus={handleMessageFocus}
          onJumpToNext={handleMessageJumpToNext}
          onJumpToPrevious={handleMessageJumpToPrevious}
          onLeave={handleMessageLeave}
          ref={messageAPIMapRef.current.get(message.id)!}
        >
          {message.children}
        </ChatMessage>
      ))}
      <div className="focus-sentinel" onFocus={handleFocusSentinelFocus} role="none" tabIndex={0} />
    </section>
  );
}

const SendBox = memo<{
  readonly onLeave: (how: 'arrow up') => void;
  readonly ref: RefObject<SendBoxAPI | undefined>;
}>(function SendBox({ onLeave, ref }) {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const focus = useCallback(() => {
    textAreaRef.current?.focus();
  }, [textAreaRef]);

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

  const handleChatHistoryLeave = useCallback(() => sendBoxRef.current?.focus(), [sendBoxRef]);
  const handleSendBoxLeave = useCallback(
    (how: 'arrow up') => {
      if (how === 'arrow up') {
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
