/* eslint-disable complexity */
import classNames from 'classnames';
import { AdaptiveCard, GlobalSettings, HostConfig } from 'adaptivecards';
import { useRefFrom } from 'use-ref-from';
import {
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';

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

type Message = {
  readonly abstract: string;
  readonly children: ReactNode | undefined;
  readonly id: string;
};

type SendBoxAPI = {
  readonly focus: () => void;
};

const ADAPTIVE_CARD_JSON = {
  type: 'AdaptiveCard',
  version: '1.5',

  body: [
    {
      type: 'Input.Text',
      label: 'Street address'
    },
    {
      type: 'Input.Text',
      label: 'City'
    },
    {
      type: 'Input.ChoiceSet',
      label: 'State',
      choices: [
        { title: 'California', value: 'CA' },
        { title: 'Oregon', value: 'OR' },
        { title: 'Washington', value: 'WA' }
      ],
      style: 'compact'
    }
  ],
  actions: [
    {
      type: 'Action.Submit',
      title: 'Submit'
    }
  ]
};

function AddressForm() {
  const ref = useRef<HTMLFormElement>(null);

  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  }, []);

  useEffect(() => {
    const adaptiveCard = new AdaptiveCard();

    adaptiveCard.hostConfig = new HostConfig({ containerStyles: { default: { backgroundColor: '#f7f7f7' } } });
    adaptiveCard.onExecuteAction = () => {
      ref.current?.closest('form')?.requestSubmit();
    };

    adaptiveCard.parse(ADAPTIVE_CARD_JSON);

    GlobalSettings.setTabIndexAtCardRoot = false;

    const element = adaptiveCard.render();

    if (element) {
      element.querySelector('.ac-textInput')?.setAttribute('data-testid', 'street address textbox');
      element.querySelector('.ac-pushButton')?.setAttribute('data-testid', 'address form submit button');

      ref.current?.appendChild(element);
    }
  }, [ref]);

  return <form data-testid="address form" ref={ref} onSubmit={handleSubmit} />;
}

function Attachment({ children }: { children: ReactNode }) {
  return (
    <div role="group">
      <div>{children}</div>
    </div>
  );
}

const CHAT_MESSAGES: readonly Message[] = Object.freeze([
  {
    // "abstract" can be built using a new "activity abstract middleware". Not sure if we should support React elements or just plain text.
    abstract: 'Bot said: Hello, World!',
    children: (
      <>
        <p>Hello, World!</p>
        <p>
          Click <a href="https://bing.com/">this link</a> for more details.
        </p>
      </>
    ),
    id: 'a-00001'
  },
  {
    abstract: 'You said: Aloha!',
    children: <p>Aloha!</p>,
    id: 'a-00002'
  },
  {
    abstract: 'Bot said: Where should we ship it to? Has an attachment.',
    children: (
      <>
        <p>Where should we ship it to?</p>
        <Attachment>
          <AddressForm />
        </Attachment>
      </>
    ),
    id: 'a-00003'
  }
]);

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
  interactMode: 1 | 2;
  messageId: string;
  onFocus: (messageId: string) => void;
  onJumpToNext: (messageId: string) => void;
  onJumpToPrevious: (messageId: string) => void;
  onLeave: (messageId: string, by: 'escape' | 'shift tab' | 'tab') => void;
  ref: RefObject<ChatMessageAPI | undefined>;
}>(function ChatMessage({
  abstract,
  children,
  interactMode,
  messageId,
  onFocus,
  onJumpToNext,
  onJumpToPrevious,
  onLeave,
  ref
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const headerId = useId();
  const interactModeRef = useRefFrom(interactMode);
  const lastFocusableRef = useRef<Element | undefined>(undefined);
  const messageIdRef = useRefFrom(messageId);
  const onFocusRef = useRefFrom(onFocus);
  const onJumpToNextRef = useRefFrom(onJumpToNext);
  const onJumpToPreviousRef = useRefFrom(onJumpToPrevious);
  const onLeaveRef = useRefFrom(onLeave);
  const rootRef = useRef<HTMLDivElement>(null);

  const focusBody = useCallback(
    ({ restoreFocus }: { restoreFocus: boolean }) => {
      if (interactModeRef.current === 1) {
        bodyRef.current?.setAttribute('tabindex', '-1');
        bodyRef.current?.focus();
      } else {
        const { current: lastFocusable } = lastFocusableRef;

        if (restoreFocus && lastFocusable) {
          (lastFocusable as HTMLElement).focus();
        } else {
          const firstFocusable = getFocusableChildren(bodyRef.current).at(0);

          firstFocusable?.focus();
        }

        onFocusRef.current?.(messageIdRef.current);
      }
    },
    [bodyRef, interactModeRef, lastFocusableRef, messageIdRef, onFocusRef]
  );

  useImperativeHandle(ref, () => Object.freeze({ focus: focusBody }), [focusBody]);

  const handleHeaderClick = useCallback<MouseEventHandler<HTMLHeadingElement>>(
    event => {
      // To support Windows Narrator quirks, the actual body is focused when clicking on the header.

      if (interactModeRef.current === 1) {
        focusBody({ restoreFocus: false });
      } else {
        event.currentTarget.nextElementSibling?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR_QUERY)?.focus();
      }
    },
    [focusBody, interactModeRef]
  );

  const handleBodyBlur = useCallback(() => {
    const { current: body } = bodyRef;

    if (interactModeRef.current === 1 && body?.getAttribute('tabindex') === '-1') {
      body.removeAttribute('tabindex');
    }
  }, [bodyRef, interactModeRef]);

  const handleBodyKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    event => {
      const { code, currentTarget, defaultPrevented, key, shiftKey } = event;

      if (defaultPrevented) {
        return;
      }

      const focusables = getFocusableChildren(currentTarget);
      const { activeElement } = document;

      if (interactModeRef.current === 1) {
        // Mode 1: Scan mode. Narrator quirks: DOWN/UP ARROW key need to be handled to allow virtual cursor to move in scan mode.
        if (key === 'ArrowDown' || (code === 'KeyJ' && event.ctrlKey)) {
          onJumpToNextRef.current?.(messageIdRef.current);

          event.preventDefault();
        } else if (key === 'ArrowUp' || (code === 'KeyK' && event.ctrlKey)) {
          onJumpToPreviousRef.current?.(messageIdRef.current);

          event.preventDefault();
        } else if (key === 'Enter') {
          // Entering interact mode by setting tabIndex=0 on every focusables, plus focusing the first one.
          const firstFocusable = focusables.at(0) as HTMLElement | undefined;

          firstFocusable?.focus();
          onFocusRef.current?.(messageIdRef.current);

          event.preventDefault();
          event.stopPropagation();
        } else if (key === 'Tab') {
          onLeaveRef.current?.(messageIdRef.current, shiftKey ? 'shift tab' : 'tab');

          event.preventDefault();
        }
      } else {
        // Mode 2: Interact mode. Windows Narrator will pass through all arrow keys and expect developers to handle them.
        if (key === 'ArrowDown') {
          if (!activeElement || !focusables.includes(activeElement as HTMLElement)) {
            (focusables.at(0) as HTMLElement | undefined)?.focus();

            event.preventDefault();
          } else if (focusables.at(-1) === activeElement) {
            // Currently focused on the last focusable.
            // Want to jump to next message, if any, or jump out of the chat history.
            onJumpToNextRef.current?.(messageIdRef.current);

            event.preventDefault();
          }
        } else if (key === 'ArrowUp') {
          if (!activeElement || !focusables.includes(activeElement as HTMLElement)) {
            (focusables.at(-1) as HTMLElement | undefined)?.focus();

            event.preventDefault();
          } else if (focusables.at(0) === activeElement) {
            // Currently focused on the first focusable.
            // Want to jump to previous message.
            onJumpToPreviousRef.current?.(messageIdRef.current);

            event.preventDefault();
          }
        } else if (key === 'Escape') {
          onLeaveRef.current?.(messageIdRef.current, 'escape');

          event.preventDefault();
        } else if (key === 'Tab') {
          if (shiftKey && focusables.at(0) === activeElement) {
            onLeaveRef.current?.(messageIdRef.current, 'shift tab');

            event.preventDefault();
          } else if (!shiftKey && focusables.at(-1) === activeElement) {
            onLeaveRef.current?.(messageIdRef.current, 'tab');

            event.preventDefault();
          }
        }
      }
    },
    [interactModeRef, messageIdRef, onFocusRef, onJumpToNextRef, onJumpToPreviousRef, onLeaveRef]
  );

  const handleRootFocusWithin = useCallback(() => {
    if (interactModeRef.current === 2) {
      const { activeElement } = document;

      if (activeElement && rootRef.current?.contains(activeElement) && activeElement !== bodyRef.current) {
        lastFocusableRef.current = activeElement;
      }

      onFocusRef.current?.(messageIdRef.current);
    }
  }, [bodyRef, interactModeRef, lastFocusableRef, messageIdRef, onFocusRef, rootRef]);

  useEffect(() => {
    const { current: root } = rootRef;

    if (root) {
      root.addEventListener('focusin', handleRootFocusWithin);

      return () => root.removeEventListener('focusin', handleRootFocusWithin);
    }

    return undefined;
  }, [handleRootFocusWithin, rootRef]);

  return (
    <article
      className={classNames('chat-message', {
        'chat-message--interact-mode-1': interactModeRef.current !== 2,
        'chat-message--interact-mode-2': interactModeRef.current === 2
      })}
      data-testid="chat message"
      ref={rootRef}
      // Required: (assumption) screen reader will associate aria-labelledby of the body to this role="article" and summarize it.
      role="article"
      // Windows Narrator quirks: we need to set tabIndex on all scan mode items, even if we want to set it to a lower roving tabindex.
      // Why roving tab index of all messages?
      //    - Assume we have 3 messages, 1st and 3rd with plain text, 2nd with interactive content
      //    - When TAB from above, it would land on the header (summary), not the interactive content in 1st message, we need to use sentinel to mark things as inert momentarily
      //    - When TAB from below, it would land on the interactive content in 3rd message, we also need to use sentinel
      // Either direction, when we are focusing from outside, we need to skip messages other than the focused one. We are using focus sentinels instead.
      // At the end of the day, roving tab index is not useful for "restoring what was last focused." We will use focus sentinels.
      // Therefore, we set all tabIndex={0} for simplicity.
      tabIndex={interactModeRef.current === 1 ? 0 : undefined}
    >
      <h1
        className="chat-message__header"
        id={headerId}
        onClick={handleHeaderClick}
        // Windows Narrator quirks: All scan mode mode item must have tabIndex. Otherwise it may send the focus to document.body.
        tabIndex={-1}
      >
        {abstract}
      </h1>
      <div
        // This element serve a single purpose, ability to programmatically focus on this element. I.e. set tabIndex={-1} then call focus(), revert on blur.
        // Perhaps, we can componentize it out as <ManualFocusable> component.
        aria-labelledby={interactMode === 2 ? bodyId : undefined} // Narrator quirks: without aria-labelledby, after pressing ENTER and focus on this element, Windows Narrator will say nothing.
        className="chat-message__body"
        data-testid="chat message body"
        id={bodyId}
        onBlur={handleBodyBlur} // Required: revert tabIndex="-1" when body is blurred.
        onKeyDown={handleBodyKeyDown}
        ref={bodyRef}
        tabIndex={interactMode === 1 ? undefined : 0}
      >
        {children}
      </div>
    </article>
  );
});

function ChatHistory({
  interactMode,
  messages,
  onLeave,
  ref
}: {
  readonly interactMode: 1 | 2;
  readonly messages: readonly Message[];
  readonly onLeave: () => void;
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

  const focus = useCallback<(focusInit: { which: 'last message' }) => void>(
    ({ which }) => {
      if (which === 'last message') {
        messageAPIMapRef.current.get(messagesRef.current?.at(-1)!.id)?.current?.focus({ restoreFocus: false });
      }
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
      messageAPIMapRef.current.set(id, { current: undefined } as unknown as RefObject<ChatMessageAPI>);
    }

    for (const id of messageIds.difference(nextMessageIds)) {
      messageAPIMapRef.current.delete(id);
    }
  }, [focusedMessageIdRef, messageAPIMapRef, messages, rootRef]);

  const jumpToRelativeMessage = useCallback(
    (messageId: string, relativePosition: number): number => {
      let index = messagesRef.current?.findIndex(({ id }) => id === messageId);
      const messagesLength = messagesRef.current.length;

      if (!~index) {
        index = messagesLength - 1;
      } else if (index + relativePosition < 0) {
        return -Infinity;
      } else if (index + relativePosition >= messagesLength) {
        return Infinity;
      }

      const nextIndex = index + relativePosition;

      const nextFocusedMessageId = messagesRef.current?.at(nextIndex)?.id;

      setFocusedMessageIDRef(nextFocusedMessageId, { shouldRenderOnChange: false });

      messageAPIMapRef.current.get(nextFocusedMessageId!)?.current?.focus({ restoreFocus: false });

      return nextIndex;
    },
    [messageAPIMapRef, messagesRef, setFocusedMessageIDRef]
  );

  const handleFocusSentinelFocus = useCallback(() => {
    const { current: focusedMessageId } = focusedMessageIdRef;

    focusedMessageId && messageAPIMapRef.current.get(focusedMessageId)?.current?.focus({ restoreFocus: true });
  }, [focusedMessageIdRef, messageAPIMapRef]);

  // Remember what message is being focused, we need this for TAB-ing from outside (i.e. focus sentinels.)
  // This function is hot path. If the message contains multiple <input>, switching <input> will send them here.
  const handleMessageFocus = useCallback(
    (id: string) => setFocusedMessageIDRef(id, { shouldRenderOnChange: false }),
    [setFocusedMessageIDRef]
  );

  const handleMessageJumpToNext = useCallback(
    (messageId: string) => {
      if (jumpToRelativeMessage(messageId, 1) === Infinity) {
        onLeaveRef.current?.();
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
        onLeaveRef.current?.();
      }
    },
    [onLeaveRef]
  );

  useImperativeHandle(ref, () => Object.freeze({ focus }), [focus]);

  return (
    <section
      className={classNames('chat-history', {
        'chat-history--interact-mode-1': interactMode !== 2,
        'chat-history--interact-mode-2': interactMode === 2
      })}
      data-testid="chat history"
      ref={rootRef}
      role="feed" // Required: we are using role="feed/article" to represent the chat thread.
    >
      <div className="focus-sentinel" onFocus={handleFocusSentinelFocus} role="none" tabIndex={0} />
      {messages.map(message => (
        <ChatMessage
          key={message.id}
          abstract={message.abstract}
          interactMode={interactMode}
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
      if (event.key === 'ArrowUp' && event.currentTarget.selectionEnd === 0) {
        onLeaveRef.current?.('arrow up');
      }
    },
    [onLeaveRef]
  );

  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => event.preventDefault(), []);

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
  const chatHistoryRef = useRef<ChatHistoryAPI | undefined>(undefined);
  const sendBoxRef = useRef<SendBoxAPI | undefined>(undefined);

  const interactMode = useMemo(() => (new URLSearchParams(location.hash.slice(1)).get('mode') === '2' ? 2 : 1), []);

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
      <ChatHistory
        messages={messages}
        interactMode={interactMode}
        onLeave={handleChatHistoryLeave}
        ref={chatHistoryRef}
      />
      <SendBox onLeave={handleSendBoxLeave} ref={sendBoxRef} />
    </div>
  );
});

export default ChatApp;
export { CHAT_MESSAGES };
